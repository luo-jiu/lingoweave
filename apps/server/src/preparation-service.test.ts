import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { LearningError, LearningStore } from './learning-store.js';
import { PreparationService, type PreparationRuntime } from './preparation-service.js';
import { seedWords } from './seed.js';

type RunOptions = Parameters<PreparationRuntime['prepare']>[0];

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function controlledRuntime(run: (options: RunOptions, stopped: Promise<void>) => Promise<void>) {
  const started = deferred<RunOptions>();
  const stopped = deferred<void>();
  let aborted = false;
  let closeCount = 0;
  const runtime: PreparationRuntime = {
    async status() {
      return {
        available: true,
        authenticated: true,
        version: 'test',
        models: [{ id: 'test-model', name: 'Test model', isDefault: true }],
        error: null,
      };
    },
    async prepare(options) {
      options.signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          stopped.resolve();
        },
        { once: true },
      );
      started.resolve(options);
      await run(options, stopped.promise);
      return { threadId: 'test-thread', model: 'test-model' };
    },
    async close() {
      closeCount += 1;
      stopped.resolve();
    },
  };
  return {
    runtime,
    started: started.promise,
    get aborted() {
      return aborted;
    },
    get closeCount() {
      return closeCount;
    },
  };
}

async function fixture(t: TestContext, runtime: PreparationRuntime) {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-service-'));
  const filename = join(directory, 'learning.sqlite');
  const store = new LearningStore(filename, seedWords);
  const service = new PreparationService(store, runtime, join(directory, 'agent'));
  service.setBaseUrl('http://127.0.0.1:1');
  t.after(async () => {
    try {
      await service.close();
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  return { filename, store, service };
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 1_500;
  while (!predicate()) {
    if (Date.now() > deadline)
      assert.fail('The preparation did not settle within the expected time.');
    await delay(10);
  }
}

test(
  'a timed progress write failure aborts the running model and settles the job',
  { timeout: 3_000 },
  async (t) => {
    const runtime = controlledRuntime(async (options, stopped) => {
      options.onText('正在准备例句。');
      await stopped;
    });
    const { store, service } = await fixture(t, runtime.runtime);
    let writes = 0;
    store.appendText = () => {
      writes += 1;
      throw new Error('simulated message storage failure');
    };
    const { jobId } = service.prepare(randomUUID());
    const options = await runtime.started;
    await waitUntil(() => runtime.aborted && store.getJob(jobId).status === 'failed');
    assert.equal(writes, 1, 'A failed flush must not be retried by the error handler.');
    assert.equal(store.snapshot().materials.length, 0);
    assert.throws(
      () => service.jobForToken(options.mcp.env.LINGOWEAVE_MCP_TOKEN ?? ''),
      (error: unknown) => error instanceof LearningError && error.code === 'UNAUTHORIZED',
    );
  },
);

test(
  'a final synchronous flush failure leaves a retryable failed job instead of running forever',
  { timeout: 3_000 },
  async (t) => {
    const runtime = controlledRuntime(async (options) => {
      options.onText('最后一段备课回复。');
    });
    const { store, service } = await fixture(t, runtime.runtime);
    let writes = 0;
    store.appendText = () => {
      writes += 1;
      throw new Error('simulated final message failure');
    };
    const { jobId } = service.prepare(randomUUID());
    await runtime.started;
    await waitUntil(() => store.getJob(jobId).status === 'failed');
    assert.equal(writes, 1);
    assert.equal(runtime.aborted, true);
    assert.equal(
      store.prepare(randomUUID()).dispatch,
      true,
      'The failed attempt permits a new attempt.',
    );
  },
);

test(
  'a message storage failure after publication preserves the complete material batch',
  { timeout: 3_000 },
  async (t) => {
    const sentences: Record<string, [string, string]> = {
      apple: ['This apple is red.', '这个苹果是红色的。'],
      book: ['This is my book.', '这是我的书。'],
      water: ['I drink water.', '我喝水。'],
      read: ['I read a book.', '我读一本书。'],
      write: ['I can write my name.', '我会写自己的名字。'],
    };
    const runtime = controlledRuntime(async (options) => {
      store.toolContext(options.jobId);
      store.publish(options.jobId, {
        requestId: 'published-once',
        materials: store.snapshot().words.map((word) => {
          const sentence = sentences[word.lemma];
          assert.ok(sentence);
          return { wordId: word.id, english: sentence[0], chinese: sentence[1] };
        }),
      });
      options.onText('例句已保存。');
    });
    const data = await fixture(t, runtime.runtime);
    const store = data.store;
    let writes = 0;
    store.appendText = () => {
      writes += 1;
      throw new Error('simulated post-commit message failure');
    };
    const { jobId } = data.service.prepare(randomUUID());
    await runtime.started;
    await waitUntil(() => runtime.aborted);
    const snapshot = store.snapshot();
    assert.equal(writes, 1);
    assert.equal(snapshot.job?.status, 'completed');
    assert.equal(snapshot.group?.stage, 'ready');
    assert.equal(snapshot.materials.length, 5);
    assert.deepEqual(store.prepare(randomUUID()), { jobId, reused: true, dispatch: false });
  },
);

test(
  'shutdown still aborts runtime and releases the database lock when failure-state storage throws',
  { timeout: 3_000 },
  async (t) => {
    const runtime = controlledRuntime(async (_options, stopped) => {
      await stopped;
    });
    const { filename, store, service } = await fixture(t, runtime.runtime);
    const { jobId } = service.prepare(randomUUID());
    await runtime.started;
    store.fail = () => {
      throw new Error('simulated state storage failure');
    };
    await service.close().catch(() => {});
    assert.equal(runtime.aborted, true);
    assert.equal(runtime.closeCount, 1);
    const recovered = new LearningStore(filename, seedWords);
    try {
      assert.equal(recovered.getJob(jobId).status, 'interrupted');
    } finally {
      recovered.close();
    }
  },
);
