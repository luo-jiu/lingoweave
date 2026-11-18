import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { miniActionSchema, miniCommandSchema, type MiniWord } from '@lingoweave/contracts';
import { MiniStore } from './mini-store.js';
import { currentLearningWord, miniCandidates, swiftTime } from './mini-study.js';
import { LearningError } from './learning-store.js';

const timezone = 'Asia/Shanghai';
const apple: MiniWord = { spelling: 'apple', meaning: '苹果', phonetic: '' };
const book: MiniWord = { spelling: 'book', meaning: '书', phonetic: '' };
const cup: MiniWord = { spelling: 'cup', meaning: '杯子', phonetic: '' };
const words = [apple, book, cup];
const example = (word: MiniWord) => ({
  word,
  english: `I have a ${word.spelling}.`,
  chinese: '我有一个。',
});
async function fixture(t: TestContext, deck = words, flow = true) {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-memory-rounds-'));
  const path = join(directory, 'study.sqlite');
  let now = new Date('2026-11-16T02:00:00.000Z');
  let store = new MiniStore(path, { now: () => now, timezone });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  store.importLegacy({
    requestId: randomUUID(),
    timezone,
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
  });
  const act = (action: z.input<typeof miniActionSchema>, requestId = randomUUID()) =>
    store.command(
      miniCommandSchema.parse({ requestId, expectedRevision: store.snapshot().revision, action }),
    );
  act({
    type: 'begin',
    target: 'daily',
    deck,
    timezone,
    ...(flow ? { flowVersion: 'memory-rounds-v1' as const } : {}),
  });
  const day = () => {
    const day = store.snapshot().ledger.days.at(-1);
    assert.ok(day);
    return day;
  };
  const context = () => ({ target: 'daily' as const, dayId: day().id });
  act({ ...context(), type: 'add_sentences', sentences: deck.map(example) });
  return {
    get store() {
      return store;
    },
    act,
    day,
    context,
    advanceMemory(word: MiniWord, round: number, remembered = true, draft?: string) {
      return act({ ...context(), type: 'memory_advance', word, round, remembered, draft });
    },
    finishMemory() {
      for (let count = 0; count < 30; count += 1) {
        const memory = day().memory;
        assert.ok(memory);
        if (memory.round === 4) return;
        const word = memory.queue[0];
        assert.ok(word);
        act({ ...context(), type: 'memory_advance', word, round: memory.round, remembered: true });
      }
      assert.fail('Memory did not finish');
    },
    spell(word: MiniWord, answer: string) {
      return act({
        ...context(),
        type: 'submit_spelling',
        session: 'learning',
        word,
        answer,
        advanceOnCorrect: false,
      });
    },
    advanceSpelling(word: MiniWord) {
      return act({ ...context(), type: 'advance_spelling', session: 'learning', word });
    },
    advanceSeconds(seconds: number) {
      now = new Date(now.getTime() + seconds * 1000);
    },
    get now() {
      return swiftTime(now);
    },
    reopen() {
      store.close();
      store = new MiniStore(path, { now: () => now, timezone });
    },
  };
}

function expectConflict(operation: () => unknown) {
  assert.throws(
    operation,
    (error) => error instanceof LearningError && error.code === 'MINI_STATE_CONFLICT',
  );
}

test('third-round retry preserves out-of-order ready words and resumes from their actual events', async (t) => {
  const data = await fixture(t, [apple, book]);
  for (const round of [1, 2]) {
    data.advanceMemory(apple, round);
    data.advanceMemory(book, round);
  }
  data.advanceMemory(apple, 3, false);
  data.advanceMemory(book, 3);
  assert.deepEqual(
    data.day().studiedWords.map((item) => item.word),
    [book],
  );
  assert.deepEqual(data.day().memory?.queue, [apple]);
  const waiting = data.store.snapshot();
  data.reopen();
  assert.deepEqual(data.store.snapshot(), waiting);

  data.advanceMemory(apple, 3);
  assert.equal(data.day().memory?.round, 4);
  assert.deepEqual(
    data.day().studiedWords.map((item) => item.word),
    [book, apple],
  );
  assert.deepEqual(data.day().learning?.queue, [apple, book]);
  assert.equal(data.day().learning?.spellingAttempts.length, 0);
  const ready = data.store.snapshot();
  data.reopen();
  assert.deepEqual(data.store.snapshot(), ready);
});

test('three rounds reuse introduced words at exact word and new-word capacity', async (t) => {
  for (const deck of [
    words,
    [
      ...words,
      { spelling: 'water', meaning: '水', phonetic: '' },
      { spelling: 'home', meaning: '家', phonetic: '' },
    ],
  ]) {
    await t.test(`${deck.length} words`, async (t) => {
      const data = await fixture(t, deck);
      data.act({
        type: 'set_session_plan',
        target: 'daily',
        wordLimit: deck.length,
        newWordLimit: deck.length,
      });
      for (const round of [1, 2, 3]) {
        for (const word of deck) {
          assert.equal(data.day().paused, false);
          if (round === 2 && word === deck[0])
            data.act({ ...data.context(), type: 'memory_reveal', word, round });
          data.advanceMemory(word, round);
          assert.equal(data.day().paused, false);
        }
      }
      const session = data.store.snapshot().planning.sessions.at(-1);
      assert.ok(session);
      assert.deepEqual(session.newWords, deck);
      assert.deepEqual(session.servedWords, deck);
      assert.equal(session.endedAt, undefined);
      assert.equal(data.day().memory?.round, 4);
    });
  }
});

test('three rounds preserve per-word progress, drafts, reveals, undo and exact recovery', async (t) => {
  const data = await fixture(t);
  const raw = '  APple 草稿  ';
  data.advanceMemory(apple, 1, true, raw);
  assert.equal(data.day().memory?.progress[0]?.completedRounds, 1);
  assert.equal(currentLearningWord(data.day())?.spelling, 'book');
  expectConflict(() => data.advanceMemory(apple, 1));
  data.act({ ...data.context(), type: 'memory_reveal', word: book, round: 1, draft: '  b  ' });
  assert.equal(data.day().memory?.revealed, true);
  data.act({ ...data.context(), type: 'memory_undo' });
  assert.equal(currentLearningWord(data.day())?.spelling, 'apple');
  assert.equal(data.day().memory?.progress[0]?.completedRounds, 0);
  assert.equal(data.day().memory?.events[0]?.undoneAt, data.now);
  assert.equal(data.day().memory?.drafts[0]?.text, raw);
  data.finishMemory();
  const day = data.day();
  assert.equal(day.memory?.round, 4);
  assert.deepEqual(
    day.memory?.progress.map((item) => item.completedRounds),
    [3, 3, 3],
  );
  assert.equal(day.studiedWords.length, 3);
  assert.equal(day.learning?.spellingAttempts.length, 0);
  assert.equal(data.store.snapshot().scheduling.probes.length, 0);
  assert.ok(data.store.snapshot().scheduling.cards.every((card) => card.fsrs === null));
  const snapshot = data.store.snapshot();
  data.reopen();
  assert.deepEqual(data.store.snapshot(), snapshot);
  assert.throws(
    () =>
      data.store.aiCommand(
        miniCommandSchema.parse({
          requestId: randomUUID(),
          expectedRevision: snapshot.revision,
          action: { ...data.context(), type: 'memory_undo' },
        }),
      ),
    { code: 'MINI_AI_ACTION_FORBIDDEN' },
  );
});

test('only failed first answers repeat and correct answers wait for explicit advance', async (t) => {
  const data = await fixture(t);
  data.finishMemory();
  data.spell(apple, '  APPLE  ');
  assert.equal(data.day().learning?.spellingState, 'readyToAdvance');
  assert.equal(data.day().learning?.queue[0]?.spelling, 'apple');
  expectConflict(() => data.spell(apple, 'apple'));
  data.advanceSpelling(apple);
  data.spell(book, 'bok');
  assert.equal(data.day().learning?.spellingState, 'correcting');
  expectConflict(() => data.advanceSpelling(book));
  data.spell(book, 'book');
  data.advanceSpelling(book);
  data.spell(cup, 'cup');
  data.advanceSpelling(cup);
  assert.deepEqual(
    data.day().learning?.queue.map((word) => word.spelling),
    ['book'],
  );
  data.spell(book, 'BOOK');
  data.advanceSpelling(book);
  const session = data.day().learning;
  assert.ok(session);
  assert.equal(session.phase, 'finished');
  assert.deepEqual(
    session.spellingAttempts.map((item) => [
      item.word.spelling,
      item.encounter,
      item.kind,
      item.answer,
    ]),
    [
      ['apple', 1, 'first', '  APPLE  '],
      ['book', 1, 'first', 'bok'],
      ['book', 1, 'correction', 'book'],
      ['cup', 1, 'first', 'cup'],
      ['book', 2, 'first', 'BOOK'],
    ],
  );
  data.reopen();
  assert.equal(data.day().learning?.phase, 'finished');
});

test('a fifth failed first answer skips immediately, persists its priority and never invents a rating', async (t) => {
  const data = await fixture(t, [apple, book]);
  data.finishMemory();
  for (let round = 1; round <= 5; round += 1) {
    data.spell(apple, `aple-${round}`);
    if (round === 5) break;
    data.spell(apple, 'apple');
    data.advanceSpelling(apple);
    if (round === 1) {
      data.spell(book, 'book');
      data.advanceSpelling(book);
    }
  }
  const session = data.day().learning;
  assert.ok(session);
  assert.equal(session.phase, 'finished');
  assert.equal(session.spellingSkips?.length, 1);
  assert.equal(session.spellingSkips?.[0]?.round, 5);
  assert.equal(
    session.spellingAttempts.filter(
      (item) => item.word.spelling === 'apple' && item.kind === 'first',
    ).length,
    5,
  );
  const card = data.store
    .snapshot()
    .scheduling.cards.find((card) => card.word.spelling === 'apple');
  assert.ok(card);
  assert.equal(card.practicePriority, 5);
  assert.equal(card.nextProbeAt, data.now + 600);
  assert.equal(card.fsrs, null);
  assert.equal(data.store.snapshot().scheduling.probes.length, 0);
  data.act({ ...data.context(), type: 'complete_learning' });
  data.advanceSeconds(601);
  const candidate = miniCandidates(
    data.store.snapshot().ledger,
    [book, apple],
    data.now,
    data.store.snapshot().scheduling,
  );
  assert.equal(candidate.due[0]?.word.spelling, 'apple');
  const history = data.store.history({ kind: 'spelling_skip', word: apple });
  assert.equal(history.items[0]?.data.mastered, false);
  const context = data.store.aiContext({ timezone });
  assert.equal(context.summary.skippedSpellingWords, 1);
  assert.equal(context.summary.highPriorityWords, 1);
  const snapshot = data.store.snapshot();
  data.reopen();
  assert.deepEqual(data.store.snapshot(), snapshot);
});

test('resuming an untouched group adopts three rounds while previously answered groups retain their facts', async (t) => {
  const data = await fixture(t, words, false);
  data.act({ ...data.context(), type: 'record_card_view', word: apple, session: 'learning' });
  const before = data.store.snapshot();
  data.act({
    type: 'begin',
    target: 'daily',
    dayId: data.day().id,
    deck: words,
    timezone,
    flowVersion: 'memory-rounds-v1',
  });
  assert.equal(data.day().memory?.round, 1);
  assert.deepEqual(data.store.snapshot().scheduling.views, before.scheduling.views);
  assert.deepEqual(data.day().sentences, before.ledger.days[0]?.sentences);
  data.advanceMemory(apple, 1);
  data.act({
    type: 'begin',
    target: 'daily',
    dayId: data.day().id,
    deck: words,
    timezone,
    flowVersion: 'memory-rounds-v1',
  });
  assert.equal(data.day().memory?.progress[0]?.completedRounds, 1);
  const legacy = await fixture(t, [apple], false);
  legacy.act({ ...legacy.context(), type: 'mark_studied', word: apple });
  const marks = legacy.day().studiedWords;
  legacy.act({
    type: 'begin',
    target: 'daily',
    dayId: legacy.day().id,
    deck: [apple],
    timezone,
    flowVersion: 'memory-rounds-v1',
  });
  assert.equal(legacy.day().memory, undefined);
  assert.deepEqual(legacy.day().studiedWords, marks);
});

test('daily review-only spelling skips a fifth failure and preserves previously answered legacy sessions', async (t) => {
  const data = await fixture(t, [apple]);
  data.finishMemory();
  data.spell(apple, 'apple');
  data.advanceSpelling(apple);
  data.act({ ...data.context(), type: 'complete_learning' });
  data.advanceSeconds(601);
  data.act({
    type: 'set_today_plan',
    target: 'daily',
    date: '2026-11-16',
    timezone,
    mode: 'reviewOnly',
    wordLimit: 5,
    newWordLimit: 0,
  });
  data.act({
    type: 'begin',
    target: 'daily',
    deck: [apple],
    timezone,
    newGroup: true,
    flowVersion: 'memory-rounds-v1',
  });
  assert.equal(data.day().learning, undefined);
  assert.equal(data.day().review?.spellingPolicy, 'retry-errors-v1');
  data.act({
    ...data.context(),
    type: 'choose_judgment',
    session: 'review',
    word: apple,
    judgment: 'clear',
  });
  data.act({ ...data.context(), type: 'advance_judgment', session: 'review', word: apple });
  const spell = (answer: string) =>
    data.act({
      ...data.context(),
      type: 'submit_spelling',
      session: 'review',
      word: apple,
      answer,
      advanceOnCorrect: false,
    });
  for (let round = 1; round <= 5; round += 1) {
    spell(`aple-${round}`);
    if (round === 5) break;
    spell('apple');
    data.act({ ...data.context(), type: 'advance_spelling', session: 'review', word: apple });
  }
  assert.equal(data.day().review?.phase, 'finished');
  assert.equal(data.day().review?.spellingSkips?.[0]?.round, 5);
  assert.equal(data.store.snapshot().scheduling.probes.length, 0);
  assert.ok(data.store.snapshot().scheduling.cards.every((card) => card.fsrs === null));
  data.act({ ...data.context(), type: 'complete_review' });
  const finished = data.store.snapshot();
  data.reopen();
  assert.deepEqual(data.store.snapshot(), finished);

  data.advanceSeconds(601);
  data.act({ type: 'begin', target: 'daily', deck: [apple], timezone, newGroup: true });
  assert.equal(data.day().review?.spellingPolicy, undefined);
  data.act({
    ...data.context(),
    type: 'choose_judgment',
    session: 'review',
    word: apple,
    judgment: 'clear',
  });
  data.act({ ...data.context(), type: 'advance_judgment', session: 'review', word: apple });
  spell('aple');
  const answered = data.day().review;
  data.act({
    type: 'begin',
    target: 'daily',
    dayId: data.day().id,
    deck: [apple],
    timezone,
    flowVersion: 'memory-rounds-v1',
  });
  assert.deepEqual(data.day().review, answered);
});

test('skip priority schedules additional practice while preserving an existing FSRS card', async (t) => {
  const data = await fixture(t, [apple, book]);
  data.act({
    type: 'set_session_plan',
    target: 'daily',
    wordLimit: 10,
    newWordLimit: 5,
  });
  data.finishMemory();
  for (let count = 0; count < 2; count += 1) {
    data.advanceSeconds(601);
    data.act({ type: 'begin_probe', target: 'daily', word: apple });
    const probeId = data.store.snapshot().scheduling.activeProbeId;
    assert.ok(probeId);
    data.act({ type: 'submit_probe', target: 'daily', probeId, answer: 'apple' });
    assert.equal(data.store.snapshot().scheduling.probes.at(-1)?.rating, 'Good');
    data.act({ type: 'end_probe', target: 'daily', probeId });
  }
  const before = data.store
    .snapshot()
    .scheduling.cards.find((card) => card.word.spelling === 'apple');
  assert.ok(before?.fsrs);
  for (let round = 1; round <= 5; round += 1) {
    data.spell(apple, `aple-${round}`);
    if (round === 5) break;
    data.spell(apple, 'apple');
    data.advanceSpelling(apple);
    if (round === 1) {
      data.spell(book, 'book');
      data.advanceSpelling(book);
    }
  }
  const after = data.store
    .snapshot()
    .scheduling.cards.find((card) => card.word.spelling === 'apple');
  assert.ok(after);
  assert.deepEqual(after.fsrs, before.fsrs);
  assert.equal(after.dueAt, before.dueAt);
  assert.equal(after.practicePriority, 5);
  assert.equal(after.nextProbeAt, data.now + 600);
  assert.ok(after.nextProbeAt < after.dueAt);
  assert.equal(data.store.snapshot().scheduling.probes.filter((probe) => probe.rating).length, 2);
  data.act({ ...data.context(), type: 'complete_learning' });
  data.advanceSeconds(601);
  const candidates = miniCandidates(
    data.store.snapshot().ledger,
    [book, apple],
    data.now,
    data.store.snapshot().scheduling,
  );
  assert.equal(candidates.due[0]?.word.spelling, 'apple');
});
