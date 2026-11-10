import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { PublishMaterialsInput, WorkspaceEvent } from '@lingoweave/contracts';
import { LearningError, LearningStore } from './learning-store.js';
import { seedWords } from './seed.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-store-'));
  const filename = join(directory, 'learning.sqlite');
  let store = new LearningStore(filename, seedWords);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    filename,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new LearningStore(filename, seedWords);
      return store;
    },
  };
}

function materials(store: LearningStore): PublishMaterialsInput {
  const sentences: Record<string, [string, string]> = {
    apple: ['This apple is red.', '这个苹果是红色的。'],
    book: ['This is my book.', '这是我的书。'],
    water: ['I drink water.', '我喝水。'],
    read: ['I read a book.', '我读一本书。'],
    write: ['I can write my name.', '我会写自己的名字。'],
  };
  return {
    requestId: randomUUID(),
    materials: store.snapshot().words.map((word) => {
      const sentence = sentences[word.lemma];
      assert.ok(sentence, `No test example for ${word.lemma}`);
      return { wordId: word.id, english: sentence[0], chinese: sentence[1] };
    }),
  };
}

function running(store: LearningStore) {
  const receipt = store.prepare(randomUUID(), 'test-model');
  assert.equal(receipt.dispatch, true);
  assert.equal(store.markRunning(receipt.jobId), true);
  return receipt.jobId;
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof LearningError && error.code === code;
}

test('committed materials, messages, sources and receipts survive closing and reopening', async (t) => {
  const data = await fixture(t);
  const requestId = randomUUID();
  const preparation = data.store.prepare(requestId, 'test-model');
  data.store.markRunning(preparation.jobId);
  data.store.setThread(preparation.jobId, 'test-thread', 'test-model');
  data.store.toolContext(preparation.jobId);
  data.store.appendText(preparation.jobId, '正在准备例句。');
  const input = materials(data.store);
  const published = data.store.publish(preparation.jobId, input);
  data.store.finishMessage(preparation.jobId);
  const saved = data.store.snapshot();

  assert.equal(saved.lexiconSize, 30);
  assert.equal(saved.materials.length, 5);
  assert.equal(saved.group?.stage, 'ready');
  assert.equal(saved.job?.status, 'completed');
  assert.deepEqual(saved.words, seedWords.slice(0, 5));
  assert.ok(saved.materials.every((material) => material.source === 'ai-generated'));

  const reopened = data.reopen();
  assert.deepEqual(reopened.snapshot(), saved);
  assert.deepEqual(reopened.publish(preparation.jobId, input), published);
  assert.deepEqual(reopened.prepare(requestId, 'test-model'), {
    ...preparation,
    dispatch: false,
  });
  assert.equal(reopened.snapshot().lastEventSeq, saved.lastEventSeq);
  assert.deepEqual(reopened.prepare(randomUUID()), {
    jobId: preparation.jobId,
    reused: true,
    dispatch: false,
  });
});

test('queued and running jobs recover as interrupted without losing the original group', async (t) => {
  for (const status of ['queued', 'running'] as const) {
    await t.test(status, async (subtest) => {
      const data = await fixture(subtest);
      const original = data.store.prepare(randomUUID());
      if (status === 'running') {
        data.store.markRunning(original.jobId);
        data.store.setThread(original.jobId, 'saved-thread', 'test-model');
        data.store.appendText(original.jobId, '已读取词组。');
      }
      const before = data.store.snapshot();
      const reopened = data.reopen();
      const recovered = reopened.snapshot();
      assert.equal(recovered.job?.id, original.jobId);
      assert.equal(recovered.job?.status, 'interrupted');
      assert.match(recovered.job?.error ?? '', /重启/);
      assert.deepEqual(recovered.group, before.group);
      assert.deepEqual(recovered.words, before.words);
      assert.deepEqual(recovered.materials, []);
      assert.equal(recovered.lastEventSeq, before.lastEventSeq + 1);
      if (status === 'running') {
        assert.equal(recovered.job?.threadId, 'saved-thread');
        assert.equal(recovered.messages[0]?.text, '已读取词组。');
        assert.equal(recovered.messages[0]?.status, 'interrupted');
      }

      const retry = reopened.prepare(randomUUID());
      assert.equal(retry.dispatch, true);
      assert.notEqual(retry.jobId, original.jobId);
      assert.equal(reopened.getJob(retry.jobId).attempt, 2);
      assert.equal(reopened.getJob(retry.jobId).groupId, before.group?.id);
      assert.equal(reopened.getJob(original.jobId).status, 'interrupted');
    });
  }
});

test('restart after material commit keeps readiness even if the agent summary was unfinished', async (t) => {
  const data = await fixture(t);
  const jobId = running(data.store);
  data.store.toolContext(jobId);
  data.store.appendText(jobId, '例句已准备');
  const input = materials(data.store);
  const receipt = data.store.publish(jobId, input);
  const committedMaterials = data.store.snapshot().materials;

  const reopened = data.reopen();
  const recovered = reopened.snapshot();
  assert.equal(recovered.job?.status, 'completed');
  assert.equal(recovered.group?.stage, 'ready');
  assert.deepEqual(recovered.materials, committedMaterials);
  assert.equal(recovered.messages[0]?.text, '例句已准备');
  assert.equal(recovered.messages[0]?.status, 'interrupted');
  assert.deepEqual(reopened.publish(jobId, input), receipt);
  assert.equal(reopened.prepare(randomUUID()).dispatch, false);
});

test('repeated prepare commands dispatch only once and active work is shared', async (t) => {
  const { store } = await fixture(t);
  const requestId = randomUUID();
  const first = store.prepare(requestId);
  const firstSeq = store.snapshot().lastEventSeq;
  assert.equal(first.dispatch, true);
  assert.deepEqual(store.prepare(requestId), { ...first, dispatch: false });
  assert.deepEqual(store.prepare(randomUUID()), {
    jobId: first.jobId,
    reused: true,
    dispatch: false,
  });
  assert.equal(store.snapshot().lastEventSeq, firstSeq);
  assert.equal(store.markRunning(first.jobId), true);
  assert.equal(store.markRunning(first.jobId), false);
  assert.equal(store.prepare(randomUUID()).dispatch, false);
  assert.equal(store.getJob(first.jobId).attempt, 1);
});

test('request identities cannot be reused for another model or command', async (t) => {
  const { store } = await fixture(t);
  const requestId = randomUUID();
  const first = store.prepare(requestId, 'first-model');
  const before = store.snapshot();
  assert.throws(() => store.prepare(requestId, 'other-model'), hasCode('REQUEST_CONFLICT'));
  assert.throws(() => store.cancel(first.jobId, requestId), hasCode('REQUEST_CONFLICT'));
  assert.deepEqual(store.snapshot(), before);
});

test('cancellation rejects late publication and late failure without creating material', async (t) => {
  const { store } = await fixture(t);
  const jobId = running(store);
  store.toolContext(jobId);
  store.appendText(jobId, '备课中的片段。');
  const input = materials(store);
  const cancellationId = randomUUID();
  const cancelled = store.cancel(jobId, cancellationId);
  const afterCancellation = store.snapshot();
  assert.equal(afterCancellation.job?.status, 'cancelled');
  assert.equal(afterCancellation.messages[0]?.status, 'interrupted');
  assert.throws(() => store.publish(jobId, input), hasCode('STALE_JOB'));
  store.fail(jobId, '迟到的错误');
  store.appendText(jobId, '迟到的文本');
  assert.equal(store.markRunning(jobId), false);
  assert.deepEqual(store.cancel(jobId, cancellationId), cancelled);
  assert.deepEqual(store.snapshot(), afterCancellation);

  const retry = store.prepare(randomUUID());
  assert.notEqual(retry.jobId, jobId);
  assert.equal(retry.dispatch, true);
  assert.throws(() => store.publish(jobId, input), hasCode('STALE_JOB'));
  assert.deepEqual(store.snapshot().materials, []);
});

test('publication requires a context read for that specific running task', async (t) => {
  const { store } = await fixture(t);
  const oldId = running(store);
  store.toolContext(oldId);
  store.cancel(oldId, randomUUID());
  const jobId = running(store);
  const input = materials(store);
  const before = store.snapshot();
  assert.throws(() => store.publish(jobId, input), hasCode('CONTEXT_REQUIRED'));
  assert.deepEqual(store.snapshot(), before);

  const context = store.toolContext(jobId);
  assert.equal(context.job?.id, jobId);
  assert.deepEqual(context.words, before.words);
  assert.deepEqual(context.history, []);
  store.publish(jobId, input);
  assert.equal(store.snapshot().group?.stage, 'ready');
});

test('invalid materials never partially save or consume the publication request identity', async (t) => {
  const { store } = await fixture(t);
  const jobId = running(store);
  store.toolContext(jobId);
  const valid = materials(store);
  const before = store.snapshot();
  const lastWordId = valid.materials.at(-1)?.wordId;
  assert.ok(lastWordId);

  const invalidSentence = {
    ...valid,
    materials: valid.materials.map((material) =>
      material.wordId === lastWordId ? { ...material, english: 'No target here.' } : material,
    ),
  };
  assert.throws(() => store.publish(jobId, invalidSentence), hasCode('INVALID_SENTENCE'));
  assert.deepEqual(store.snapshot(), before);

  const invalidTargets = {
    ...valid,
    materials: valid.materials.map((material) =>
      material.wordId === lastWordId ? { ...material, wordId: 'unknown-word' } : material,
    ),
  };
  assert.throws(() => store.publish(jobId, invalidTargets), hasCode('INVALID_TARGETS'));
  assert.deepEqual(store.snapshot(), before);

  const invalidShape = {
    ...valid,
    materials: valid.materials.map((material) => ({ ...material, chinese: '   ' })),
  };
  assert.throws(() => store.publish(jobId, invalidShape));
  assert.deepEqual(store.snapshot(), before);

  store.publish(jobId, valid);
  assert.equal(store.snapshot().materials.length, 5);
  assert.equal(store.snapshot().job?.status, 'completed');
});

test('a committed publication survives cancellation and replays its original receipt', async (t) => {
  const { store } = await fixture(t);
  const jobId = running(store);
  store.toolContext(jobId);
  const input = materials(store);
  const published = store.publish(jobId, input);
  const saved = store.snapshot();
  const cancellationId = randomUUID();
  const cancelled = store.cancel(jobId, cancellationId);
  assert.deepEqual(cancelled, { jobId, reused: true });
  assert.deepEqual(store.cancel(jobId, cancellationId), cancelled);
  assert.deepEqual(store.publish(jobId, input), published);
  assert.deepEqual(store.snapshot(), saved);

  const changed = {
    ...input,
    materials: input.materials.map((material) => ({ ...material, chinese: '另一个翻译。' })),
  };
  assert.throws(() => store.publish(jobId, changed), hasCode('REQUEST_CONFLICT'));
  assert.deepEqual(store.snapshot(), saved);
});

test('a storage failure during publication rolls back the whole batch and permits retry', async (t) => {
  const data = await fixture(t);
  const jobId = running(data.store);
  data.store.toolContext(jobId);
  const input = materials(data.store);
  const before = data.store.snapshot();
  const sabotage = new DatabaseSync(data.filename);
  try {
    sabotage.exec(`
      CREATE TRIGGER test_storage_failure BEFORE INSERT ON materials
      WHEN (SELECT COUNT(*) FROM materials) = 2
      BEGIN SELECT RAISE(ABORT, 'test storage failure'); END;
    `);
    assert.throws(() => data.store.publish(jobId, input), /test storage failure/);
    assert.deepEqual(data.store.snapshot(), before);
    sabotage.exec('DROP TRIGGER test_storage_failure;');
    data.store.publish(jobId, input);
    assert.equal(data.store.snapshot().materials.length, 5);
    assert.equal(data.store.snapshot().job?.status, 'completed');
  } finally {
    sabotage.close();
  }
});

test('the data directory admits one service at a time and can reopen after close', async (t) => {
  const data = await fixture(t);
  const jobId = running(data.store);
  assert.throws(() => new LearningStore(data.filename, seedWords), /already open/);
  assert.equal(data.store.getJob(jobId).status, 'running');
  data.store.close();
  data.store.close();
  assert.equal(existsSync(`${data.filename}.lock`), false);
  assert.equal(data.reopen().getJob(jobId).status, 'interrupted');
});

test('a failed SQLite open releases the data-directory lock', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-store-open-error-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'database-is-directory');
  await mkdir(filename);
  assert.throws(() => new LearningStore(filename, seedWords));
  assert.equal(existsSync(`${filename}.lock`), false);
});

test('subscribers see committed state and event cursors replay in increasing order', async (t) => {
  const data = await fixture(t);
  const observed: WorkspaceEvent[] = [];
  const persistenceObserved: Array<{ durable: boolean; snapshotSeq: number }> = [];
  const observer = new DatabaseSync(data.filename, { readOnly: true });
  try {
    const unsubscribeThrowing = data.store.subscribe(() => {
      throw new Error('Disconnected client');
    });
    const unsubscribe = data.store.subscribe((event) => {
      observed.push(event);
      persistenceObserved.push({
        durable: Boolean(observer.prepare('SELECT seq FROM events WHERE seq = ?').get(event.seq)),
        snapshotSeq: data.store.snapshot().lastEventSeq,
      });
    });
    const first = data.store.prepare(randomUUID());
    const initialCursor = data.store.snapshot().lastEventSeq;
    data.store.markRunning(first.jobId);
    data.store.appendText(first.jobId, '读取词组。');
    data.store.toolContext(first.jobId);
    data.store.publish(first.jobId, materials(data.store));
    data.store.finishMessage(first.jobId);

    const all = data.store.eventsAfter(0);
    assert.deepEqual(observed, all);
    assert.deepEqual(
      persistenceObserved,
      all.map((event) => ({ durable: true, snapshotSeq: event.seq })),
    );
    assert.deepEqual(
      all.map((event) => event.seq),
      [1, 2, 3, 4, 5],
    );
    assert.deepEqual(
      all.map((event) => event.kind),
      ['job', 'job', 'message', 'materials', 'message'],
    );
    assert.deepEqual(data.store.eventsAfter(initialCursor), all.slice(1));
    assert.deepEqual(data.store.eventsAfter(all.at(-1)?.seq ?? 0), []);

    unsubscribe();
    unsubscribeThrowing();
    data.store.appendText(first.jobId, '完成。');
    assert.equal(observed.length, all.length);
    assert.equal(data.store.eventsAfter(0).length, all.length + 1);
  } finally {
    observer.close();
  }
});
