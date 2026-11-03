import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiErrorSchema, healthResponseSchema } from '@lingoweave/contracts';
import { buildApp } from './app.js';
import { parseConfig } from './config.js';

test('health returns the shared contract and a server-generated request identity', async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  const response = await app.inject({
    url: '/api/health',
    headers: { 'x-request-id': 'untrusted-id' },
  });
  assert.equal(response.statusCode, 200);
  const health = healthResponseSchema.parse(response.json());
  assert.equal(health.service, 'lingoweave-api');
  assert.ok(Math.abs(Date.now() - Date.parse(health.timestamp)) < 5_000);
  assert.ok(response.headers['x-request-id']);
  assert.notEqual(response.headers['x-request-id'], 'untrusted-id');
});

test('unknown API routes return JSON errors, including /api itself', async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  for (const url of ['/api', '/api/missing']) {
    const response = await app.inject({ url, headers: { accept: 'text/html' } });
    assert.equal(response.statusCode, 404);
    const body = apiErrorSchema.parse(response.json());
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(body.error.requestId, response.headers['x-request-id']);
  }
});

test('unexpected failures hide internal details', async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  app.get('/api/broken', () => {
    throw new Error('secret diagnostic details');
  });

  const response = await app.inject('/api/broken');
  assert.equal(response.statusCode, 500);
  assert.equal(apiErrorSchema.parse(response.json()).error.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(response.body, /secret|stack/);
});

test('malformed JSON is rejected using the stable error contract', async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  app.post('/api/echo', async () => ({ ok: true }));

  const response = await app.inject({
    method: 'POST',
    url: '/api/echo',
    headers: { 'content-type': 'application/json' },
    payload: '{invalid json',
  });
  assert.equal(response.statusCode, 400);
  assert.equal(apiErrorSchema.parse(response.json()).error.code, 'BAD_REQUEST');
});

test('arbitrary thrown values and invalid error statuses remain safe server errors', async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  app.get('/api/non-error', () => Promise.reject('sensitive diagnostic text'));
  app.get('/api/invalid-status', () =>
    Promise.reject({ statusCode: 503.5, message: 'sensitive diagnostic text' }),
  );

  for (const url of ['/api/non-error', '/api/invalid-status']) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 500);
    assert.equal(apiErrorSchema.parse(response.json()).error.code, 'INTERNAL_ERROR');
    assert.doesNotMatch(response.body, /sensitive/);
  }
});

test('production serves the SPA without swallowing missing APIs or assets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lingoweave-static-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>LingoWeave fixture</title>');
  await writeFile(join(root, 'assets', 'app.js'), 'console.log("fixture");');

  const app = buildApp({ staticRoot: root });
  t.after(() => app.close());

  const health = await app.inject('/api/health');
  assert.equal(health.statusCode, 200);
  healthResponseSchema.parse(health.json());

  for (const url of ['/', '/learn', '/learn/today?source=test']) {
    const response = await app.inject({ url, headers: { accept: 'text/html' } });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /LingoWeave fixture/);
  }

  const asset = await app.inject('/assets/app.js');
  assert.equal(asset.statusCode, 200);
  assert.match(asset.headers['content-type'] ?? '', /javascript/);

  for (const url of ['/api', '/api/missing', '/assets/missing', '/missing.js']) {
    const response = await app.inject({ url, headers: { accept: 'text/html' } });
    assert.equal(response.statusCode, 404);
    assert.equal(apiErrorSchema.parse(response.json()).error.code, 'NOT_FOUND');
  }

  const nonNavigation = await app.inject('/unknown');
  assert.equal(nonNavigation.statusCode, 404);
  const head = await app.inject({
    method: 'HEAD',
    url: '/learn',
    headers: { accept: 'text/html' },
  });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  const post = await app.inject({
    method: 'POST',
    url: '/learn',
    headers: { accept: 'text/html' },
  });
  assert.equal(post.statusCode, 404);
});

test('missing production frontend build fails before startup', () => {
  assert.throws(() => buildApp({ staticRoot: '/lingoweave-missing-build-for-test' }), /pnpm build/);
});

test('configuration uses local defaults and accepts valid overrides', () => {
  assert.deepEqual(parseConfig({}), { nodeEnv: 'development', host: '127.0.0.1', port: 4310 });
  assert.deepEqual(parseConfig({ NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '4321' }), {
    nodeEnv: 'production',
    host: '127.0.0.1',
    port: 4321,
  });
});

test('configuration rejects invalid ports and environments before listening', () => {
  for (const port of ['', '0', '-1', '1.5', '65536', 'not-a-port']) {
    assert.throws(() => parseConfig({ PORT: port }), /Invalid server configuration: PORT/);
  }
  assert.throws(() => parseConfig({ NODE_ENV: 'staging' }), /NODE_ENV/);
  assert.throws(() => parseConfig({ HOST: '   ' }), /HOST/);
});
