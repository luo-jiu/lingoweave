import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import {
  miniActionSchema,
  miniCommandSchema,
  miniImportSchema,
  defaultMiniPlanning,
  defaultMiniTeaching,
  defaultMiniScheduling,
  defaultMiniPractice,
  type MiniDay,
  type MiniWord,
} from '@lingoweave/contracts';
import { generatorParameters } from 'ts-fsrs';
import { LearningError } from './learning-store.js';
import { MiniStore } from './mini-store.js';
import { calendarDue, currentTranslation, swiftTime, validateMiniFacts } from './mini-study.js';

const apple: MiniWord = { spelling: 'apple', meaning: '苹果', phonetic: '' };
const book: MiniWord = { spelling: 'book', meaning: '书', phonetic: '' };
const water: MiniWord = { spelling: 'water', meaning: '水', phonetic: '' };
const timezone = 'Asia/Shanghai';
const example = (word: MiniWord) => ({
  word,
  english: `I see ${word.spelling}.`,
  chinese: `我看见${word.meaning}。`,
});
const feedback = {
  outcome: 'partial' as const,
  comment: '意思表达清楚。',
  tip: '可调整冠词。',
  usefulPhrase: 'an apple',
};
const hasCode = (code: string) => (error: unknown) =>
  error instanceof LearningError && error.code === code;
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-mini-'));
  const filename = join(directory, 'mini.sqlite');
  let date = new Date('2026-11-01T04:00:00.000Z');
  let store = new MiniStore(filename, { now: () => date, timezone });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const act = (
    action: z.input<typeof miniActionSchema>,
    requestId: string = randomUUID(),
    revision = store.snapshot().revision,
  ) => store.command(miniCommandSchema.parse({ requestId, expectedRevision: revision, action }));
  return {
    filename,
    get store() {
      return store;
    },
    act,
    setDate(value: string) {
      date = new Date(value);
    },
    reopen() {
      store.close();
      store = new MiniStore(filename, { now: () => date, timezone });
      return store;
    },
    initialize() {
      return store.importLegacy({
        requestId: randomUUID(),
        ledger: { days: [] },
        reviewRecord: null,
        reviewHistory: [],
        timezone,
      });
    },
  };
}
function lastDay(data: Awaited<ReturnType<typeof fixture>>): MiniDay {
  const day = data.store.snapshot().ledger.days.at(-1);
  assert.ok(day);
  return day;
}
function context(data: Awaited<ReturnType<typeof fixture>>) {
  return { target: 'daily' as const, dayId: lastDay(data).id };
}
function finishLearning(data: Awaited<ReturnType<typeof fixture>>, miss?: MiniWord) {
  const day = lastDay(data);
  const ctx = context(data);
  const missing = day.learningWords.filter(
    (word) => !day.sentences.some((sentence) => sentence.word.spelling === word.spelling),
  );
  if (missing.length) data.act({ ...ctx, type: 'add_sentences', sentences: missing.map(example) });
  for (const word of day.learningWords) data.act({ ...ctx, type: 'mark_studied', word });
  let answeredMiss = false;
  for (let guard = 0; guard < 30; guard += 1) {
    const word = lastDay(data).learning?.queue[0];
    if (!word) break;
    if (!answeredMiss && miss && word.spelling === miss.spelling) {
      data.act({ ...ctx, type: 'submit_spelling', session: 'learning', word, answer: '  aplpe ' });
      answeredMiss = true;
    }
    data.act({ ...ctx, type: 'submit_spelling', session: 'learning', word, answer: word.spelling });
  }
  data.act({ ...ctx, type: 'complete_learning' });
  prepareWriting(data);
}
function prepareWriting(data: Awaited<ReturnType<typeof fixture>>) {
  const day = lastDay(data);
  const prompts = [...day.reviewWords, ...day.learningWords].flatMap((word, index) => {
    const direction = day.directions[index];
    return direction &&
      !day.writingPrompts?.some((item) => item.sentence.word.spelling === word.spelling)
      ? [
          {
            id: randomUUID(),
            sentence: {
              word,
              english: `We need ${word.spelling} today.`,
              chinese: `我们今天需要${word.meaning}。`,
            },
            direction,
            focusIds: [],
          },
        ]
      : [];
  });
  if (prompts.length) data.act({ ...context(data), type: 'publish_writing', prompts });
}
function finishTranslations(data: Awaited<ReturnType<typeof fixture>>) {
  prepareWriting(data);
  for (let guard = 0; guard < 10; guard += 1) {
    const day = lastDay(data);
    const task = currentTranslation(day);
    if (!task) break;
    const ctx = context(data);
    data.act({ ...ctx, type: 'submit_translation', taskId: task.id, answer: '  原始作答  ' });
    const attempt = lastDay(data).translation.at(-1);
    assert.ok(attempt);
    data.act({ ...ctx, type: 'record_feedback', attemptId: attempt.id, feedback });
    data.act({ ...ctx, type: 'advance_translation', taskId: task.id });
  }
}

test('mini requires an explicit one-time import; reimport and receipts never overwrite newer facts', async (t) => {
  const data = await fixture(t);
  assert.deepEqual(data.store.snapshot(), {
    schemaVersion: 1,
    revision: 0,
    imported: false,
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
    planning: defaultMiniPlanning(),
    teaching: defaultMiniTeaching(),
    scheduling: {
      ...defaultMiniScheduling(),
      parameters: { ...defaultMiniScheduling().parameters, weights: [...generatorParameters().w] },
    },
    practice: defaultMiniPractice(),
    assessmentSources: [],
  });
  assert.throws(
    () => data.act({ type: 'begin', target: 'daily', deck: [apple], timezone }),
    hasCode('MINI_IMPORT_REQUIRED'),
  );
  const source = miniImportSchema.parse({
    requestId: randomUUID(),
    ledger: { days: [] },
    reviewHistory: [],
    timezone,
  });
  assert.equal(source.reviewRecord, null);
  data.store.importLegacy(source);
  data.act({ type: 'begin', target: 'daily', deck: [apple], timezone });
  const before = data.store.snapshot();
  assert.deepEqual(data.store.importLegacy(source), before);
  assert.deepEqual(data.store.importLegacy({ ...source, requestId: randomUUID() }), before);
  assert.throws(
    () => data.store.importLegacy({ ...source, requestId: randomUUID(), timezone: 'UTC' }),
    hasCode('MINI_ALREADY_IMPORTED'),
  );
  assert.deepEqual(data.reopen().snapshot(), before);
});

test('commands preserve first answers, revelations, complete batch rounds and qualitative feedback without rescheduling', async (t) => {
  const data = await fixture(t);
  data.initialize();
  data.act({ type: 'begin', target: 'daily', deck: [book, apple], timezone });
  finishLearning(data, book);
  const day = lastDay(data);
  assert.deepEqual(
    day.learning?.spellingAttempts
      .filter((attempt) => attempt.kind === 'first')
      .map((attempt) => [attempt.word.spelling, attempt.encounter, attempt.correct]),
    [
      ['apple', 1, true],
      ['book', 1, false],
      ['book', 2, true],
      ['apple', 2, true],
    ],
  );
  const missed = day.learning?.spellingAttempts.find((item) => !item.correct);
  assert.equal(missed?.answer, '  aplpe ');
  assert.equal(missed?.revealedAnswerAt, swiftTime(new Date('2026-11-01T04:00:00Z')));
  assert.equal(
    day.scheduleUpdates.find((item) => item.word.spelling === 'book')?.dueAt,
    swiftTime(new Date('2026-11-01T16:00:00Z')),
  );
  assert.equal(
    day.scheduleUpdates.find((item) => item.word.spelling === 'apple')?.dueAt,
    swiftTime(new Date('2026-11-02T16:00:00Z')),
  );
  const schedules = structuredClone(day.scheduleUpdates);
  finishTranslations(data);
  const completed = lastDay(data);
  assert.equal(completed.phase, 'finished');
  assert.deepEqual(completed.scheduleUpdates, schedules);
  assert.equal(completed.translation[0]?.answer, '  原始作答  ');
  assert.equal(completed.translation[0]?.feedback?.outcome, 'partial');
  assert.deepEqual(data.reopen().snapshot().ledger.days.at(-1), completed);
});

test('due selection reuses canonical material and previous direction, review promotion uses original answers', async (t) => {
  const data = await fixture(t);
  data.initialize();
  data.act({ type: 'begin', target: 'daily', deck: [book, apple], timezone });
  finishLearning(data, book);
  finishTranslations(data);
  data.setDate('2026-11-02T04:00:00Z');
  const repronounced = { ...book, phonetic: '/bʊk/' };
  data.act({ type: 'begin', target: 'daily', deck: [apple, repronounced, water], timezone });
  const next = lastDay(data);
  const ctx = context(data);
  assert.deepEqual(next.reviewWords, [apple, repronounced]);
  assert.deepEqual(next.learningWords, [water]);
  assert.equal(
    next.sentences.find((sentence) => sentence.word.spelling === 'book')?.english,
    example(book).english,
  );
  assert.equal(next.directions[1], 'chineseToEnglish');
  for (const word of next.reviewWords) {
    data.act({ ...ctx, type: 'choose_judgment', session: 'review', word, judgment: 'clear' });
    data.act({ ...ctx, type: 'advance_judgment', session: 'review', word });
  }
  for (const word of lastDay(data).review?.queue ?? [])
    data.act({
      ...ctx,
      type: 'submit_spelling',
      session: 'review',
      word,
      answer: word.spelling.toUpperCase(),
    });
  data.act({ ...ctx, type: 'complete_review' });
  assert.equal(
    lastDay(data).scheduleUpdates.find((item) => item.word.spelling === 'book')?.dueAt,
    swiftTime(new Date('2026-11-04T16:00:00Z')),
  );
  finishLearning(data);
  assert.equal(currentTranslation(lastDay(data))?.direction, 'englishToChinese');
  assert.ok(
    data.store.snapshot().scheduling.cards.every((card) => card.fsrs === null),
    'A practice pass never fabricates a FSRS Good',
  );
});

test('pause and drafts survive restart; stale words, days, versions and repeated IDs are rejected atomically', async (t) => {
  const data = await fixture(t);
  data.initialize();
  data.act({ type: 'begin', target: 'daily', deck: [apple], timezone });
  const ctx = context(data);
  data.act({ ...ctx, type: 'add_sentences', sentences: [example(apple)] });
  data.act({ ...ctx, type: 'mark_studied', word: apple });
  data.act({ ...ctx, type: 'spelling_draft', session: 'learning', word: apple, draft: 'appl' });
  data.act({ ...ctx, type: 'pause', paused: true });
  const saved = data.store.snapshot();
  assert.deepEqual(data.reopen().snapshot(), saved);
  assert.equal(lastDay(data).learning?.spellingDraft, 'appl');
  assert.throws(
    () =>
      data.act({
        ...ctx,
        type: 'submit_spelling',
        session: 'learning',
        word: apple,
        answer: 'apple',
      }),
    hasCode('MINI_STATE_CONFLICT'),
  );
  data.setDate('2026-11-01T11:00:00Z');
  data.act({ type: 'begin', target: 'daily', deck: [book], timezone });
  assert.deepEqual(lastDay(data).learningWords, [apple]);
  data.act({ ...ctx, type: 'pause', paused: false });
  const requestId = randomUUID();
  const revision = data.store.snapshot().revision;
  const action = {
    ...ctx,
    type: 'submit_spelling' as const,
    session: 'learning' as const,
    word: apple,
    answer: 'apple',
  };
  const committed = data.act(action, requestId, revision);
  assert.deepEqual(data.act(action, requestId.toUpperCase(), revision), committed);
  assert.throws(
    () => data.act({ ...action, answer: 'different' }, requestId, revision),
    hasCode('REQUEST_CONFLICT'),
  );
  assert.throws(() => data.act(action, randomUUID(), revision), hasCode('MINI_REVISION_CONFLICT'));
  const before = data.store.snapshot();
  assert.throws(
    () => data.act({ ...ctx, type: 'complete_learning', dayId: '2026-10-01' }),
    hasCode('MINI_STATE_CONFLICT'),
  );
  assert.deepEqual(data.store.snapshot(), before);
});

test('legacy standalone review preserves capped judgment repeats and later unassisted spelling passes', async (t) => {
  const data = await fixture(t);
  data.initialize();
  data.act({ type: 'begin', target: 'review', deck: [apple, book], timezone, startIndex: 0 });
  const record = data.store.snapshot().reviewRecord;
  assert.ok(record);
  const ctx = { target: 'review' as const, recordId: record.id };
  for (let guard = 0; guard < 10; guard += 1) {
    const session = data.store.snapshot().reviewRecord?.session;
    assert.ok(session);
    if (session.phase !== 'judgment') break;
    const word = session.queue[0];
    assert.ok(word);
    data.act({
      ...ctx,
      type: 'choose_judgment',
      word,
      judgment: word.spelling === 'apple' ? 'fuzzy' : 'clear',
    });
    data.act({ ...ctx, type: 'advance_judgment', word });
  }
  assert.equal(
    data.store
      .snapshot()
      .reviewRecord?.session.judgmentEvents.filter((event) => event.word.spelling === 'apple')
      .length,
    3,
  );
  data.act({ ...ctx, type: 'submit_spelling', word: book, answer: 'book' });
  data.act({ ...ctx, type: 'submit_spelling', word: apple, answer: 'aplpe' });
  data.act({ ...ctx, type: 'submit_spelling', word: apple, answer: 'apple' });
  assert.equal(data.store.snapshot().reviewRecord?.session.queue[0]?.spelling, 'apple');
  data.act({ ...ctx, type: 'submit_spelling', word: apple, answer: 'apple' });
  data.act({ ...ctx, type: 'continue_to_learning' });
  assert.equal(data.store.snapshot().reviewRecord?.continuedToLearning, true);
  data.act({ type: 'begin', target: 'review', deck: [water], timezone });
  assert.equal(data.store.snapshot().reviewHistory[0]?.id, record.id);
  assert.throws(
    () => data.act({ ...ctx, type: 'pause', paused: true }),
    hasCode('MINI_STATE_CONFLICT'),
  );
});

test('a persisted pre-shuffle spelling round resumes in place and shuffles only the next eligible round', async (t) => {
  const source = await fixture(t);
  source.initialize();
  const deck = [apple, book, water];
  source.act({ type: 'begin', target: 'review', deck, timezone, flowVersion: 'memory-rounds-v1' });
  const record = source.store.snapshot().reviewRecord;
  assert.ok(record);
  const ctx = { target: 'review' as const, recordId: record.id };
  for (const word of deck) {
    source.act({ ...ctx, type: 'choose_judgment', word, judgment: 'clear' });
    source.act({ ...ctx, type: 'advance_judgment', word });
  }

  const old = source.store.snapshot().reviewRecord;
  assert.ok(old);
  delete old.session.spellingRounds;
  old.session.queue = [...deck];
  old.session.spellingDraft = 'ap';
  const data = await fixture(t);
  data.store.importLegacy({
    requestId: randomUUID(),
    reviewRecord: old,
    ledger: { days: [] },
    reviewHistory: [],
    timezone,
  });
  assert.deepEqual(data.reopen().snapshot().reviewRecord, old);
  for (const word of [apple, book]) {
    data.act({ ...ctx, type: 'submit_spelling', word, answer: 'miss' });
    data.act({ ...ctx, type: 'submit_spelling', word, answer: word.spelling });
  }
  const before = data.store.snapshot();
  assert.deepEqual(before.reviewRecord?.session.queue, [water, apple, book]);
  assert.equal(before.reviewRecord?.session.spellingRounds, undefined);
  const cmd = { ...ctx, type: 'submit_spelling' as const, word: water, answer: water.spelling };
  const id = randomUUID();
  const second = data.act(cmd, id, before.revision);
  assert.deepEqual(second.reviewRecord?.session.queue, [book, apple]);
  assert.deepEqual(second.reviewRecord?.session.spellingRounds, [{ round: 2, order: [1, 0] }]);
  assert.deepEqual(data.reopen().snapshot(), second);
  assert.deepEqual(data.act(cmd, id, before.revision), second);
  const broken = structuredClone(second);
  const order = broken.reviewRecord?.session.spellingRounds?.[0]?.order;
  assert.ok(order);
  order[0] = 0;
  assert.throws(() => validateMiniFacts(broken), hasCode('MINI_STATE_CONFLICT'));
});

test('legacy import validates associations and original results without erasing corrupt input or accepting invalid dates', async (t) => {
  const data = await fixture(t);
  data.initialize();
  data.act({ type: 'begin', target: 'daily', deck: [apple], timezone });
  finishLearning(data);
  finishTranslations(data);
  const historical = data.store.snapshot();
  historical.ledger.days[0]?.scheduleUpdates.push({
    word: apple,
    dueAt: 1000,
    step: 0,
    source: 'translation',
    recordedAt: 100,
    policyVersion: 1,
  });
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-mini-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MiniStore(join(directory, 'mini.sqlite'));
  t.after(() => store.close());
  const source = {
    requestId: randomUUID(),
    ledger: historical.ledger,
    reviewRecord: null,
    reviewHistory: [],
  };
  const corrupt = structuredClone(source);
  const first = corrupt.ledger.days[0]?.learning?.spellingAttempts[0];
  assert.ok(first);
  first.correct = false;
  assert.throws(() => store.importLegacy(corrupt), hasCode('MINI_STATE_CONFLICT'));
  assert.equal(store.snapshot().imported, false);
  assert.ok(
    !miniImportSchema.safeParse({
      ...source,
      ledger: { days: [{ ...source.ledger.days[0], startedAt: 1e100 }] },
    }).success,
  );
  const imported = store.importLegacy(source);
  assert.equal(imported.ledger.days[0]?.scheduleUpdates.at(-1)?.source, 'translation');
  assert.equal(
    (await readFile(join(directory, 'mini.sqlite'))).subarray(0, 6).toString(),
    'SQLite',
  );
});

test('calendar schedules respect local midnight, DST, and day identity near UTC midnight', () => {
  assert.equal(
    calendarDue(swiftTime(new Date('2026-03-07T17:00:00Z')), 2, 'America/New_York'),
    swiftTime(new Date('2026-03-09T04:00:00Z')),
  );
  assert.equal(
    calendarDue(swiftTime(new Date('2026-10-31T16:00:00Z')), 2, 'America/New_York'),
    swiftTime(new Date('2026-11-02T05:00:00Z')),
  );
  assert.equal(
    calendarDue(swiftTime(new Date('2026-11-01T23:00:00Z')), 1, timezone),
    swiftTime(new Date('2026-11-02T16:00:00Z')),
  );
});

test('import cannot forge ready spelling or encounters to turn a supported miss into a pass', async (t) => {
  const data = await fixture(t);
  data.initialize();
  data.act({ type: 'begin', target: 'review', deck: [apple], timezone });
  const record = data.store.snapshot().reviewRecord;
  assert.ok(record);
  const ctx = { target: 'review' as const, recordId: record.id };
  data.act({ ...ctx, type: 'choose_judgment', word: apple, judgment: 'clear' });
  data.act({ ...ctx, type: 'advance_judgment', word: apple });
  data.act({ ...ctx, type: 'submit_spelling', word: apple, answer: 'aple' });
  const source = data.store.snapshot();
  const corrupted = structuredClone(source.reviewRecord);
  assert.ok(corrupted);
  corrupted.session.spellingState = 'readyToAdvance';
  const destination = await fixture(t);
  assert.throws(
    () =>
      destination.store.importLegacy({
        requestId: randomUUID(),
        ledger: { days: [] },
        reviewRecord: corrupted,
        reviewHistory: [],
      }),
    hasCode('MINI_STATE_CONFLICT'),
  );
  assert.equal(destination.store.snapshot().imported, false);
  const valid = source.reviewRecord;
  assert.ok(valid);
  const imported = destination.store.importLegacy({
    requestId: randomUUID(),
    ledger: { days: [] },
    reviewRecord: valid,
    reviewHistory: [],
  });
  assert.throws(
    () => destination.act({ ...ctx, type: 'advance_spelling', word: apple }),
    hasCode('MINI_STATE_CONFLICT'),
  );
  assert.deepEqual(destination.store.snapshot(), imported);
  destination.act({ ...ctx, type: 'submit_spelling', word: apple, answer: 'apple' });
  assert.equal(destination.store.snapshot().reviewRecord?.session.queue[0]?.spelling, 'apple');
});

test('durable offline commands retain occurrence time across midnight and reject future timestamps', async (t) => {
  const data = await fixture(t);
  data.initialize();
  data.act({ type: 'begin', target: 'review', deck: [apple], timezone });
  const record = data.store.snapshot().reviewRecord;
  assert.ok(record);
  const occurredAt = swiftTime(new Date('2026-11-01T15:59:00Z'));
  const pending = miniCommandSchema.parse({
    requestId: randomUUID(),
    expectedRevision: data.store.snapshot().revision,
    occurredAt,
    action: {
      target: 'review',
      recordId: record.id,
      type: 'choose_judgment',
      word: apple,
      judgment: 'clear',
    },
  });
  data.setDate('2026-11-02T04:00:00Z');
  const accepted = data.store.command(pending);
  assert.equal(accepted.reviewRecord?.session.judgmentEvents[0]?.selectedAt, occurredAt);
  assert.deepEqual(data.reopen().command(pending), accepted);
  assert.throws(
    () =>
      data.store.command({
        ...pending,
        requestId: randomUUID(),
        expectedRevision: accepted.revision,
        occurredAt: swiftTime(new Date('2026-11-03T04:00:00Z')),
      }),
    hasCode('MINI_EVENT_TIME_INVALID'),
  );
  assert.deepEqual(data.store.snapshot(), accepted);
});

test('invalid preparation is atomic and does not consume a request identity or alter frozen targets', async (t) => {
  const data = await fixture(t);
  data.initialize();
  data.act({ type: 'begin', target: 'daily', deck: [apple, book], timezone });
  const ctx = context(data);
  const before = data.store.snapshot();
  const requestId = randomUUID();
  assert.throws(
    () =>
      data.act(
        { ...ctx, type: 'add_sentences', sentences: [example(apple), example(water)] },
        requestId,
      ),
    hasCode('MINI_STATE_CONFLICT'),
  );
  assert.deepEqual(data.store.snapshot(), before);
  data.act(
    { ...ctx, type: 'add_sentences', sentences: [example(apple), example(book)] },
    requestId,
  );
  assert.equal(lastDay(data).sentences.length, 2);
  assert.throws(
    () => data.act({ ...ctx, type: 'mark_studied', word: book }),
    hasCode('MINI_STATE_CONFLICT'),
  );
  assert.equal(lastDay(data).studiedWords.length, 0);
});

test('legacy fixed groups keep the original feedback and can submit a later translation revision', async (t) => {
  const data = await fixture(t);
  data.initialize();
  data.act({ type: 'begin', target: 'daily', deck: [apple, book], timezone });
  finishLearning(data);
  const ctx = context(data);
  const task = currentTranslation(lastDay(data));
  assert.ok(task);
  data.act({ ...ctx, type: 'submit_translation', taskId: task.id, answer: '第一版' });
  const first = lastDay(data).translation[0];
  assert.ok(first);
  data.act({ ...ctx, type: 'record_feedback', attemptId: first.id, feedback });
  data.act({ ...ctx, type: 'advance_translation', taskId: task.id });
  const next = currentTranslation(lastDay(data));
  assert.ok(next);
  data.act({
    ...ctx,
    type: 'revise_translation',
    taskId: task.id,
    attemptId: first.id,
    answer: '修改后',
  });
  const stored = lastDay(data).translation[0];
  const revision = stored?.revisions?.at(-1);
  assert.ok(revision);
  assert.equal(currentTranslation(lastDay(data))?.id, next.id);
  assert.equal(stored?.feedback?.comment, feedback.comment);
  assert.equal(data.store.assessmentSource(revision.id)?.answer, '修改后');
  assert.equal(data.store.assessmentSource(revision.id)?.attemptId, first.id);
  data.reopen();
  assert.equal(lastDay(data).translation[0]?.revisions?.length, 1);
});
