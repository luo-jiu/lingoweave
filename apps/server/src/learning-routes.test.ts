import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { apiErrorSchema, workspaceSnapshotSchema } from '@lingoweave/contracts';
import { buildApp } from './app.js';
import { LearningStore } from './learning-store.js';
import { PreparationService, type PreparationRuntime } from './preparation-service.js';
import { seedWords } from './seed.js';

type PrepareOptions = Parameters<PreparationRuntime['prepare']>[0];
const sentences = [
  'I eat an apple.',
  'This book is good.',
  'I drink water.',
  'I read every day.',
  'I write my name.',
];
const materials = seedWords.slice(0, 5).map((word, index) => ({
  wordId: word.id,
  english: sentences[index] ?? '',
  chinese: `测试例句 ${index + 1}`,
}));

function fakeRuntime(run: (options: PrepareOptions) => Promise<void>): PreparationRuntime {
  return {
    status: async () => ({
      available: true,
      authenticated: true,
      version: 'fixture',
      models: [{ id: 'fixture', name: 'Fixture', isDefault: true }],
      error: null,
    }),
    prepare: async (options) => {
      options.onThread?.({ threadId: 'fixture-thread', model: 'fixture' });
      await run(options);
      return { threadId: 'fixture-thread', model: 'fixture' };
    },
    close: async () => {},
  };
}

test('HTTP validates inputs, rejects foreign origins and protects the scoped tool endpoint', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lingoweave-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new PreparationService(
    new LearningStore(':memory:', seedWords),
    fakeRuntime(async () => {}),
    root,
  );
  service.setBaseUrl('http://127.0.0.1:1234');
  const app = buildApp({ learning: service });
  t.after(() => app.close());
  const initial = await app.inject('/api/learning');
  assert.equal(workspaceSnapshotSchema.parse(initial.json()).lexiconSize, 30);
  const invalid = await app.inject({
    method: 'POST',
    url: '/api/learning/prepare',
    payload: { requestId: 'bad' },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(apiErrorSchema.parse(invalid.json()).error.code, 'INVALID_INPUT');
  const foreign = await app.inject({
    method: 'POST',
    url: '/api/learning/prepare',
    headers: { host: '127.0.0.1:1234', origin: 'https://example.com' },
    payload: { requestId: randomUUID() },
  });
  assert.equal(foreign.statusCode, 403);
  const unauthorized = await app.inject({
    method: 'POST',
    url: '/api/internal/learning',
    payload: { action: 'context' },
  });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(service.store.snapshot().job, null);
});

test(
  'the actual stdio MCP calls HTTP services and saves one complete group with a durable receipt',
  { timeout: 15_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'lingoweave-mcp-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let dispatches = 0;
    let resolveFinished: () => void = () => {};
    let rejectFinished: (reason: unknown) => void = () => {};
    const finished = new Promise<void>((resolve, reject) => {
      resolveFinished = resolve;
      rejectFinished = reject;
    });
    const runtime = fakeRuntime(async (options) => {
      dispatches += 1;
      const client = new Client({ name: 'lingoweave-mcp-regression', version: '1.0.0' });
      const transport = new StdioClientTransport({
        command: options.mcp.command,
        args: options.mcp.args,
        env: options.mcp.env,
        stderr: 'pipe',
      });
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
          'learning_get_context',
          'learning_publish_materials',
        ]);
        const context = await client.callTool({ name: 'learning_get_context', arguments: {} });
        assert.notEqual(context.isError, true);
        assert.match(JSON.stringify(context.content), /en:apple:noun:fruit/);
        const input = { requestId: 'fixture-publication', materials };
        const first = await client.callTool({
          name: 'learning_publish_materials',
          arguments: input,
        });
        assert.notEqual(first.isError, true);
        const replay = await client.callTool({
          name: 'learning_publish_materials',
          arguments: input,
        });
        assert.deepEqual(replay.content, first.content);
        options.onText('五个词的材料已经保存。');
        resolveFinished();
      } catch (error) {
        rejectFinished(error);
        throw error;
      } finally {
        await client.close();
      }
    });
    const store = new LearningStore(join(root, 'learning.sqlite'), seedWords);
    const service = new PreparationService(store, runtime, join(root, 'agent'));
    const app = buildApp({ learning: service });
    t.after(() => app.close());
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    service.setBaseUrl(address);
    const request = { requestId: randomUUID() };
    const first = await app.inject({
      method: 'POST',
      url: '/api/learning/prepare',
      headers: { origin: address, host: new URL(address).host },
      payload: request,
    });
    assert.equal(first.statusCode, 202);
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/learning/prepare',
      payload: request,
    });
    assert.deepEqual(duplicate.json(), first.json());
    await finished;
    const snapshot = store.snapshot();
    assert.equal(snapshot.group?.stage, 'ready');
    assert.equal(snapshot.materials.length, 5);
    assert.equal(snapshot.job?.status, 'completed');
    assert.equal(dispatches, 1);
    const cached = await app.inject({
      method: 'POST',
      url: '/api/learning/prepare',
      payload: { requestId: randomUUID() },
    });
    assert.equal(cached.json().reused, true);
    assert.equal(dispatches, 1);
  },
);

test(
  'cancelling via HTTP aborts the active turn and rejects its late tool requests',
  { timeout: 5_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'lingoweave-cancel-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let token = '';
    let aborted = false;
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const runtime = fakeRuntime(async (options) => {
      token = options.mcp.env.LINGOWEAVE_MCP_TOKEN ?? '';
      await new Promise<void>((resolve) => {
        options.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
        started();
      });
    });
    const service = new PreparationService(new LearningStore(':memory:', seedWords), runtime, root);
    service.setBaseUrl('http://127.0.0.1:1234');
    const app = buildApp({ learning: service });
    t.after(() => app.close());
    const receipt = await app.inject({
      method: 'POST',
      url: '/api/learning/prepare',
      payload: { requestId: randomUUID() },
    });
    const jobId: string = receipt.json().jobId;
    await ready;
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/learning/jobs/${jobId}/cancel`,
      payload: { requestId: randomUUID() },
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(aborted, true);
    const late = await app.inject({
      method: 'POST',
      url: '/api/internal/learning',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'publish', input: { requestId: 'late', materials } },
    });
    assert.equal(late.statusCode, 401);
    assert.equal(service.store.snapshot().materials.length, 0);
    assert.equal(service.store.snapshot().job?.status, 'cancelled');
  },
);

test(
  'SSE replays events and closes before shutdown without blocking saved state recovery',
  { timeout: 5_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'lingoweave-sse-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = join(root, 'learning.sqlite');
    const store = new LearningStore(file, seedWords);
    const service = new PreparationService(
      store,
      fakeRuntime(async () => {}),
      root,
    );
    const app = buildApp({ learning: service });
    t.after(() => app.close());
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    service.setBaseUrl(address);
    const job = store.prepare(randomUUID());
    const response = await fetch(`${address}/api/learning/events?after=0`);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = response.body?.getReader();
    assert.ok(reader);
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /event: update/);
    await app.close();
    let done = false;
    while (!done) done = (await reader.read()).done;
    const recovered = new LearningStore(file, seedWords);
    t.after(() => recovered.close());
    assert.equal(recovered.getJob(job.jobId).status, 'interrupted');
  },
);
