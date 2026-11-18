import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { apiErrorSchema, miniSnapshotSchema, miniPlanPreviewSchema } from '@lingoweave/contracts';
import { buildApp } from './app.js';
import { MiniStore } from './mini-store.js';

const token = 'a'.repeat(64);
const authorization = `Bearer ${token}`;

test('mini HTTP protects all reads and writes, validates commands and returns authoritative snapshots', async (t) => {
  const store = new MiniStore(':memory:', {
    now: () => new Date('2026-11-13T04:00:00Z'),
    timezone: 'Asia/Shanghai',
  });
  const app = buildApp({ mini: { store, token } });
  t.after(() => app.close());
  for (const [method, url] of [
    ['GET', '/api/mini/snapshot'],
    ['POST', '/api/mini/import'],
    ['POST', '/api/mini/commands'],
    ['POST', '/api/mini/plan-preview'],
  ] as const) {
    const response = await app.inject({
      method,
      url,
      ...(method === 'POST' ? { payload: {} } : {}),
    });
    assert.equal(response.statusCode, 401);
    assert.equal(apiErrorSchema.parse(response.json()).error.code, 'UNAUTHORIZED');
  }
  const browser = await app.inject({
    method: 'GET',
    url: '/api/mini/snapshot',
    headers: { authorization, origin: 'http://127.0.0.1:4311' },
  });
  assert.equal(browser.statusCode, 403);
  const initial = await app.inject({
    method: 'GET',
    url: '/api/mini/snapshot',
    headers: { authorization },
  });
  assert.equal(miniSnapshotSchema.parse(initial.json()).revision, 0);
  const preview = await app.inject({
    method: 'POST',
    url: '/api/mini/plan-preview',
    headers: { authorization },
    payload: {
      deck: [{ spelling: 'apple', meaning: '苹果', phonetic: '' }],
      timezone: 'Asia/Shanghai',
    },
  });
  assert.equal(preview.statusCode, 200);
  const overview = miniPlanPreviewSchema.parse(preview.json());
  assert.equal(overview.planContext.newCount, 1);
  assert.equal(overview.revision, 0);
  assert.deepEqual(overview.ledger.days, []);
  assert.deepEqual(store.snapshot(), miniSnapshotSchema.parse(initial.json()));
  const corrupt = await app.inject({
    method: 'POST',
    url: '/api/mini/import',
    headers: { authorization },
    payload: { requestId: randomUUID(), ledger: { days: [{ id: 'bad' }] }, reviewHistory: [] },
  });
  assert.equal(corrupt.statusCode, 400);
  const imported = await app.inject({
    method: 'POST',
    url: '/api/mini/import',
    headers: { authorization },
    payload: {
      requestId: randomUUID(),
      ledger: { days: [] },
      reviewHistory: [],
      timezone: 'Asia/Shanghai',
    },
  });
  assert.equal(imported.statusCode, 200);
  assert.equal(miniSnapshotSchema.parse(imported.json()).imported, true);
  const payload = {
    requestId: randomUUID(),
    expectedRevision: 1,
    action: {
      type: 'begin',
      target: 'daily',
      deck: [{ spelling: 'apple', meaning: '苹果', phonetic: '' }],
      timezone: 'Asia/Shanghai',
    },
  };
  const begun = await app.inject({
    method: 'POST',
    url: '/api/mini/commands',
    headers: { authorization },
    payload,
  });
  assert.equal(begun.statusCode, 200);
  const state = miniSnapshotSchema.parse(begun.json());
  assert.equal(state.ledger.days[0]?.id, '2026-11-13');
  assert.equal(state.ledger.days[0]?.phase, 'learning');
  const repeated = await app.inject({
    method: 'POST',
    url: '/api/mini/commands',
    headers: { authorization },
    payload,
  });
  assert.deepEqual(repeated.json(), begun.json());
  const stale = await app.inject({
    method: 'POST',
    url: '/api/mini/commands',
    headers: { authorization },
    payload: { ...payload, requestId: randomUUID() },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(apiErrorSchema.parse(stale.json()).error.code, 'MINI_REVISION_CONFLICT');
  const overwrite = await app.inject({
    method: 'POST',
    url: '/api/mini/commands',
    headers: { authorization },
    payload: {
      requestId: randomUUID(),
      expectedRevision: 2,
      action: { type: 'replace', target: 'daily', ledger: { days: [] } },
    },
  });
  assert.equal(overwrite.statusCode, 400);
  assert.deepEqual(store.snapshot(), state);
});
