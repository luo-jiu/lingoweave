import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  apiErrorSchema,
  miniPatternResultSchema,
  miniPatternSnapshotSchema,
  miniPhrasePageSchema,
  type MiniPatternPractice,
  type MiniPatternSnapshot,
} from '@lingoweave/contracts';
import { buildApp } from './app.js';
import { patternCurriculum } from './mini-pattern-curriculum.js';
import { MiniStore } from './mini-store.js';

const timezone = 'Asia/Shanghai';
const start = Date.parse('2026-11-18T04:00:00Z');
const dayMs = 24 * 3600 * 1000;
function inputFor(batch: MiniPatternSnapshot): MiniPatternPractice {
  const card = batch.batch.find((item) => !batch.completedIds.includes(item.id));
  const answer = patternCurriculum.find((item) => item.card.id === card?.id)?.references[0];
  assert.ok(card && answer);
  return {
    requestId: randomUUID(),
    timezone,
    batchId: batch.batchId,
    patternId: card.id,
    answer,
    usedHint: false,
  };
}
function finishBatch(store: MiniStore, hints = 0) {
  let current = store.patterns(timezone);
  while (current.completedIds.length < current.batch.length) {
    const result = store.practicePattern({
      ...inputFor(current),
      usedHint: current.completedIds.length < hints,
    });
    assert.ok(result.correct);
    current = result.snapshot;
  }
  return current;
}

test('only one introduction batch per study day; read-only preview expires and unfinished batch survives a long gap', (t) => {
  let now = start;
  const store = new MiniStore(':memory:', { now: () => new Date(now) });
  t.after(() => store.close());
  const wordFacts = store.snapshot();
  const first = store.patterns(timezone);
  assert.equal(first.batch.length, 5);
  assert.equal(first.canDialogue, false);
  assert.deepEqual(store.patternContext().practiced, []);
  now += dayMs;
  assert.throws(() => store.practicePattern(inputFor(first)), /句式进度/);
  const resumed = store.practicePattern(inputFor(store.patterns(timezone))).snapshot;
  now += 10 * dayMs;
  assert.equal(store.patterns(timezone).batchId, resumed.batchId);
  const finished = finishBatch(store);
  assert.deepEqual(store.patterns(timezone), finished);
  now += dayMs;
  assert.equal(finishBatch(store).batch.length, 3);
  now += dayMs;
  assert.equal(finishBatch(store).batch.length, 2);
  now += dayMs;
  assert.deepEqual(store.patterns(timezone).batch, []);
  assert.equal(store.patternContext().practiced.length, 10);
  assert.deepEqual(store.snapshot(), wordFacts);
});

test('next same-tier intake falls to two after frequent support and does not mistake extra failed attempts for more difficult frames', (t) => {
  let now = start;
  for (const hints of [2, 3]) {
    const store = new MiniStore(':memory:', { now: () => new Date(now) });
    t.after(() => store.close());
    finishBatch(store, hints);
    now += dayMs;
    const next = store.patterns(timezone);
    assert.equal(next.batch.length, hints === 3 ? 2 : 3);
  }
});

test('switching the saved proficiency tier introduces the A2 extension, not a word-level or FSRS side effect', (t) => {
  let now = start;
  const store = new MiniStore(':memory:', { now: () => new Date(now) });
  t.after(() => store.close());
  store.importLegacy({
    requestId: randomUUID(),
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
    timezone,
  });
  finishBatch(store);
  now += dayMs;
  store.command({
    requestId: randomUUID(),
    expectedRevision: store.snapshot().revision,
    action: {
      type: 'remember_preference',
      target: 'daily',
      key: 'english_level',
      value: 'A2',
      sourceMessageId: randomUUID(),
    },
  });
  const original = store.snapshot();
  const batch = store.patterns(timezone);
  assert.equal(batch.level, 'A2');
  assert.equal(batch.practicedCount, 0);
  assert.equal(batch.canDialogue, true);
  assert.equal(batch.batch.length, 2);
  assert.ok(
    store.practicePattern({ ...inputFor(batch), answer: ' I am going to READ this book ' }).correct,
  );
  assert.deepEqual(store.snapshot(), original);
});

test('version 8 study data migrates additively and version 12 stays untouched', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-pattern-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'mini.sqlite');
  let store = new MiniStore(file, { now: () => new Date(start) });
  t.after(() => store.close());
  store.importLegacy({
    requestId: randomUUID(),
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
    timezone,
  });
  const original = store.command({
    requestId: randomUUID(),
    expectedRevision: store.snapshot().revision,
    action: {
      type: 'begin',
      target: 'daily',
      deck: [{ spelling: 'book', meaning: '书', phonetic: '' }],
      timezone,
    },
  });
  store.close();
  const old = new DatabaseSync(file);
  const body = old.prepare('SELECT body FROM mini_state WHERE id=1').get()?.body;
  old.exec(
    'DROP TABLE mini_pattern_attempts; DROP TABLE mini_pattern_batches; PRAGMA user_version=8',
  );
  old.close();
  store = new MiniStore(file, { now: () => new Date(start) });
  assert.deepEqual(store.snapshot(), original);
  assert.deepEqual(store.patternContext().practiced, []);
  assert.ok(store.practicePattern(inputFor(store.patterns(timezone))).correct);
  store.close();
  const future = new DatabaseSync(file);
  try {
    assert.equal(future.prepare('SELECT body FROM mini_state WHERE id=1').get()?.body, body);
    assert.equal(future.prepare('PRAGMA user_version').get()?.user_version, 13);
    future.exec('PRAGMA user_version=14');
    assert.throws(() => new MiniStore(file), /newer/);
    assert.equal(future.prepare('PRAGMA user_version').get()?.user_version, 14);
  } finally {
    future.close();
  }
});

test('restart, idempotency, explicit supported continuation and guided correction retain original answers without manufacturing mastery', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-patterns-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'mini.sqlite');
  const options = { now: () => new Date(start) };
  let store = new MiniStore(file, options);
  t.after(() => store.close());
  const batch = store.patterns(timezone);
  const original = inputFor(batch);
  assert.throws(
    () => store.practicePattern({ ...original, usedHint: true, continueAfterFeedback: true }),
    /先尝试/,
  );
  const different = { ...original, answer: 'Could I have a pen?' };
  const first = store.practicePattern(different);
  assert.equal(first.correct, false);
  assert.equal(first.reference, 'I need a pen.');
  assert.deepEqual(first.snapshot, batch);
  assert.deepEqual(store.patternContext().practiced, []);
  store.close();
  store = new MiniStore(file, options);
  assert.deepEqual(store.practicePattern(different), first);
  assert.throws(() => store.practicePattern(original), /相同请求/);
  assert.throws(
    () =>
      store.practicePattern({
        ...different,
        requestId: randomUUID(),
        answer: 'Changed!',
        usedHint: true,
        continueAfterFeedback: true,
      }),
    /先尝试/,
  );
  const skipped = store.practicePattern({
    ...different,
    requestId: randomUUID(),
    usedHint: true,
    continueAfterFeedback: true,
  });
  assert.equal(skipped.correct, false);
  assert.deepEqual(skipped.snapshot.completedIds, [original.patternId]);
  assert.equal(store.patternContext().practiced[0]?.independent, false);
  assert.throws(() => store.practicePattern({ ...original, requestId: randomUUID() }), /句式进度/);
  const second = inputFor(skipped.snapshot);
  assert.equal(store.practicePattern({ ...second, answer: 'not sure' }).correct, false);
  const corrected = store.practicePattern({ ...second, requestId: randomUUID() });
  assert.ok(corrected.correct);
  assert.equal(store.patternContext().practiced.at(-1)?.independent, false);
  const third = inputFor(corrected.snapshot);
  assert.ok(store.practicePattern({ ...third, answer: '  i LIKE tea!  ' }).correct);
  assert.equal(store.patternContext().practiced.at(-1)?.independent, true);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const originals = db
      .prepare(
        "SELECT json_extract(input,'$.answer') AS answer, at_ms FROM mini_pattern_attempts ORDER BY seq",
      )
      .all();
    assert.deepEqual(
      originals.map((o) => o.answer),
      [different.answer, different.answer, 'not sure', second.answer, 'i LIKE tea!'],
    );
    assert.ok(originals.every((o) => o.at_ms === start));
  } finally {
    db.close();
  }
});

test('pattern HTTP endpoints require native auth, validate timezone/input and refuse out-of-batch practice', async (t) => {
  const store = new MiniStore(':memory:', { now: () => new Date(start) });
  const token = 'p'.repeat(64),
    headers = { authorization: `Bearer ${token}` };
  const app = buildApp({ mini: { store, token } });
  t.after(() => app.close());
  const url = '/api/mini/patterns?timezone=Asia%2FShanghai';
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
  assert.equal(
    (await app.inject({ method: 'GET', url, headers: { ...headers, origin: 'null' } })).statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/mini/patterns?timezone=not-a-zone', headers }))
      .statusCode,
    400,
  );
  const result = await app.inject({ method: 'GET', url, headers });
  const batch = miniPatternSnapshotSchema.parse(result.json());
  const payload = inputFor(batch);
  const post = '/api/mini/patterns/practice';
  assert.equal((await app.inject({ method: 'POST', url: post, payload })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: post,
        headers,
        payload: { ...payload, answer: '  ' },
      })
    ).statusCode,
    400,
  );
  const stale = await app.inject({
    method: 'POST',
    url: post,
    headers,
    payload: { ...payload, patternId: 'a2-plan' },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(apiErrorSchema.parse(stale.json()).error.code, 'MINI_PATTERN_CONFLICT');
  const success = await app.inject({ method: 'POST', url: post, headers, payload });
  assert.equal(success.statusCode, 200);
  assert.ok(miniPatternResultSchema.parse(success.json()).correct);
});

test('phrase history records just the displayed frame, catches a failed first answer from the old client, and survives reopen', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-phrases-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'study.sqlite');
  const options = { now: () => new Date(start) };
  const store = new MiniStore(path, options);
  const token = 'p'.repeat(64);
  const headers = { authorization: 'Bearer ' + token };
  const app = buildApp({ mini: { store, token } });
  t.after(() => app.close());
  const batch = store.patterns(timezone);
  const first = inputFor(batch);
  const card = batch.batch[0];
  const unseen = batch.batch[1];
  assert.ok(card && unseen);
  const url = '/api/mini/phrases';
  const get = async (query = '') => {
    const response = await app.inject({ method: 'GET', url: url + query, headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    return miniPhrasePageSchema.parse(response.json());
  };
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
  assert.equal(
    (await app.inject({ method: 'GET', url, headers: { ...headers, origin: 'null' } })).statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: url + '?limit=101', headers })).statusCode,
    400,
  );
  const viewUrl = '/api/mini/patterns/view';
  const view = async (patternId: string) =>
    app.inject({
      method: 'POST',
      url: viewUrl,
      headers,
      payload: { timezone, batchId: batch.batchId, patternId },
    });
  assert.equal((await view(unseen.id)).statusCode, 409);
  const words = store.snapshot();
  assert.equal((await get()).total, 0);
  assert.equal((await view(card.id)).statusCode, 200);
  assert.equal((await view(card.id)).statusCode, 200);
  assert.equal((await get('?q=' + encodeURIComponent(card.meaning))).items[0]?.status, 'viewed');
  store.practicePattern(first);
  const next = inputFor(store.patterns(timezone));
  const wrong = 'private writing content';
  store.practicePattern({ ...next, answer: wrong });
  const page = await get('?kind=pattern');
  assert.deepEqual(page.items.map((i) => i.status).sort(), ['attempted', 'practiced']);
  assert.ok(!JSON.stringify(page).includes(wrong));
  assert.equal((await get('?limit=1&offset=1')).items[0]?.id, page.items[1]?.id);
  assert.deepEqual(store.snapshot(), words);
  await app.close();
  const reopened = new MiniStore(path, options);
  try {
    assert.deepEqual(reopened.phrases({ q: '', kind: 'pattern', offset: 0, limit: 50 }), page);
  } finally {
    reopened.close();
  }
});

test('a frame seen again in a later batch refreshes its library date just once for that batch', (t) => {
  let time = start;
  const store = new MiniStore(':memory:', { now: () => new Date(time) });
  t.after(() => store.close());
  const show = () => {
    const batch = store.patterns(timezone);
    const first = batch.batch[0];
    assert.ok(first);
    store.viewPattern({ timezone, batchId: batch.batchId, patternId: first.id });
    const page = store.phrases({ q: '', offset: 0, limit: 50 });
    assert.equal(page.total, 1);
    return page.items[0];
  };
  const first = show();
  assert.ok(first);
  time += dayMs;
  assert.deepEqual(show(), { ...first, lastSeenAt: first.lastSeenAt + 86400 });
  time += 1000;
  assert.deepEqual(show(), { ...first, lastSeenAt: first.lastSeenAt + 86400 });
});
