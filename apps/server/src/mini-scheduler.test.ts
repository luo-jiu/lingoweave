import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createEmptyCard, fsrs, Rating } from 'ts-fsrs';
import {
  miniCommandSchema,
  defaultMiniScheduling,
  type MiniAction,
  type MiniWord,
} from '@lingoweave/contracts';
import { buildApp } from './app.js';
import { MiniStore } from './mini-store.js';
import { miniMemory, orderMiniDue } from './mini-scheduler.js';
import { swiftTime } from './mini-study.js';

const apple: MiniWord = { spelling: 'apple', meaning: '苹果', phonetic: '/ˈæpəl/' };
const book: MiniWord = { spelling: 'book', meaning: '书', phonetic: '' };
const timezone = 'Asia/Shanghai';
const example = (word: MiniWord) => ({
  word,
  english: `I see ${word.spelling}.`,
  chinese: `我看见${word.meaning}。`,
});
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-measurement-'));
  const filename = join(directory, 'mini.sqlite');
  let date = new Date('2026-11-16T04:00:00Z');
  let store = new MiniStore(filename, { now: () => date, timezone });
  store.importLegacy({
    requestId: randomUUID(),
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
    timezone,
  });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const act = (action: MiniAction) =>
    store.command(
      miniCommandSchema.parse({
        requestId: randomUUID(),
        expectedRevision: store.snapshot().revision,
        action,
      }),
    );
  const probe = () => {
    const current = store.snapshot().scheduling.probes.at(-1);
    assert.ok(current);
    return current;
  };
  return {
    get store() {
      return store;
    },
    act,
    probe,
    get date() {
      return date;
    },
    advance(seconds: number) {
      date = new Date(date.getTime() + seconds * 1000);
    },
    begin(word = apple) {
      act({ type: 'begin_probe', target: 'daily', word });
      return probe();
    },
    answer(answer: string) {
      act({ type: 'submit_probe', target: 'daily', probeId: probe().id, answer });
      return probe();
    },
    end() {
      act({ type: 'end_probe', target: 'daily', probeId: probe().id });
    },
    reopen() {
      store.close();
      store = new MiniStore(filename, { now: () => date, timezone });
    },
  };
}

test('only objective independent first probes enter the exact locked FSRS model; copies and revelations do not', async (t) => {
  const data = await fixture(t);
  const first = data.begin();
  const answered = data.answer('  APPLE  ');
  assert.equal(answered.classification, 'independent_success');
  assert.equal(answered.rating, 'Good');
  assert.equal(answered.answer, '  APPLE  ');
  assert.equal(answered.revealedAt, answered.submittedAt);
  const expected = fsrs({
    request_retention: 0.9,
    enable_fuzz: false,
    enable_short_term: true,
    learning_steps: ['10m'],
    relearning_steps: ['10m'],
  }).next(createEmptyCard(data.date), data.date, Rating.Good).card;
  const card = miniMemory(data.store.snapshot(), apple);
  assert.ok(card?.fsrs);
  assert.equal(card.dueAt, swiftTime(expected.due));
  assert.equal(card.fsrs.stability, expected.stability);
  assert.equal(card.fsrs.difficulty, expected.difficulty);
  assert.equal(card.fsrs.reps, 1);
  const original = structuredClone(data.store.snapshot());
  assert.throws(() => data.answer('aple'));
  assert.deepEqual(
    data.store.snapshot(),
    original,
    'A later answer cannot replace the first result or schedule',
  );
  data.end();
  data.advance(1);
  data.begin();
  assert.equal(data.answer('apple').classification, 'too_soon');
  assert.equal(miniMemory(data.store.snapshot(), apple)?.fsrs?.reps, 1);
  data.end();
  data.advance(600);
  data.begin();
  data.act({ type: 'reveal_probe', target: 'daily', probeId: data.probe().id });
  const supported = data.answer('wrong');
  assert.equal(supported.classification, 'supported');
  assert.equal(supported.rating, undefined);
  assert.equal(miniMemory(data.store.snapshot(), apple)?.fsrs?.reps, 1);
  assert.equal(
    data.store.snapshot().scheduling.probes.find((probe) => probe.id === first.id)?.answer,
    '  APPLE  ',
  );
});

test('the actual exposure interval and intervening real target determine eligibility at both boundaries', async (t) => {
  for (const [seconds, interleaved, expected] of [
    [59, true, 'too_soon'],
    [60, true, 'independent_success'],
    [299, false, 'too_soon'],
    [300, false, 'independent_success'],
  ] as const) {
    await t.test(`${seconds}s, interleaved=${interleaved}`, async (child) => {
      const data = await fixture(child);
      data.act({ type: 'record_card_view', target: 'daily', word: apple });
      data.act({ type: 'hide_card', target: 'daily', word: apple });
      assert.equal(
        data.store.snapshot().scheduling.cards.length,
        0,
        'Browsing does not silently enroll a word into a learning plan',
      );
      if (interleaved) {
        data.advance(10);
        data.begin(book);
        data.answer('book');
        data.end();
        data.advance(seconds - 10);
      } else data.advance(seconds);
      data.begin();
      assert.equal(data.answer('apple').classification, expected);
      assert.equal(data.probe().measurement?.interveningOtherTarget, interleaved);
    });
  }
});

test('browsing the viewport records only the listed senses at observation time without scheduling them', async (t) => {
  const data = await fixture(t);
  data.begin(book);
  data.answer('book');
  data.end();
  const before = data.store.snapshot();
  data.advance(310);
  const seen = swiftTime(data.date);
  data.advance(40);
  const command = miniCommandSchema.parse({
    requestId: randomUUID(),
    expectedRevision: before.revision,
    occurredAt: seen,
    action: { type: 'record_browse_views', target: 'daily', words: [apple, book] },
  });
  const saved = data.store.command(command);
  assert.deepEqual(
    saved.scheduling.views
      .slice(before.scheduling.views.length)
      .map(({ word, at }) => ({ word, at })),
    [
      { word: apple, at: seen },
      { word: book, at: seen },
    ],
  );
  assert.equal(saved.scheduling.cards.length, before.scheduling.cards.length);
  assert.equal(miniMemory(saved, apple), undefined);
  assert.deepEqual(miniMemory(saved, book), {
    ...miniMemory(before, book),
    lastAnswerExposureAt: seen,
  });
  assert.equal(saved.scheduling.visibleWord, before.scheduling.visibleWord);
  assert.deepEqual(saved.scheduling.flow, before.scheduling.flow);
  assert.deepEqual(saved.ledger, before.ledger);
  assert.deepEqual(saved.planning, before.planning);
  data.reopen();
  assert.deepEqual(data.store.command(command), saved);
  data.begin({ ...apple, meaning: '苹果公司' });
  assert.equal(data.answer('apple').classification, 'too_soon');
  data.end();
  data.begin({ spelling: 'tea', meaning: '茶', phonetic: '' });
  assert.equal(data.answer('tea').classification, 'independent_success');
});

test('viewport observations cannot forge independence on an active spelling probe', async (t) => {
  const data = await fixture(t);
  data.begin();
  data.advance(300);
  data.act({
    type: 'record_browse_views',
    target: 'daily',
    words: [book, { ...apple, meaning: '另一词义' }],
  });
  assert.deepEqual(data.probe().helpSources, ['ui']);
  assert.equal(data.answer('apple').classification, 'supported');
  const invalidWords = [
    [],
    [apple, { ...apple, spelling: ' APPLE ', phonetic: '' }],
    [{ ...apple, spelling: ' ' }],
    Array.from({ length: 65 }, (_, i) => ({ ...book, spelling: String(i) })),
  ];
  for (const words of invalidWords)
    assert.equal(
      miniCommandSchema.safeParse({
        requestId: randomUUID(),
        expectedRevision: 0,
        action: { type: 'record_browse_views', target: 'daily', words },
      }).success,
      false,
    );
});

test('independent failure is saved once; late chat help and later correction cannot overwrite Again', async (t) => {
  const data = await fixture(t);
  data.begin();
  assert.equal(data.answer('  aple  ').classification, 'independent_failure');
  const before = structuredClone(data.probe());
  const memory = structuredClone(miniMemory(data.store.snapshot(), apple));
  data.advance(2);
  data.act({
    type: 'record_probe_help',
    target: 'daily',
    probeId: before.id,
    source: 'chat',
    sourceMessageId: randomUUID(),
  });
  assert.equal(data.probe().rating, 'Again');
  assert.equal(data.probe().answer, before.answer);
  assert.deepEqual(data.probe().scheduleAfter, before.scheduleAfter);
  assert.deepEqual(miniMemory(data.store.snapshot(), apple)?.fsrs, memory?.fsrs);
  assert.throws(() => data.answer('apple'));
  data.end();
  data.advance(600);
  data.begin();
  data.act({
    type: 'record_probe_help',
    target: 'daily',
    probeId: data.probe().id,
    source: 'chat',
    sourceMessageId: randomUUID(),
  });
  assert.equal(data.answer('apple').classification, 'supported');
  assert.equal(miniMemory(data.store.snapshot(), apple)?.fsrs?.reps, 1);
});

test('queued dictation preserves click times, identities and answer order across late receipts', async (t) => {
  const data = await fixture(t);
  data.act({
    type: 'begin',
    target: 'daily',
    deck: [apple],
    timezone,
    flowVersion: 'sliding-window-v2',
  });
  const dayId = data.store.snapshot().planning.activeDayId;
  assert.ok(dayId);
  const ctx = { target: 'daily', dayId, session: 'learning' } as const;
  data.act({ ...ctx, type: 'add_sentences', sentences: [example(apple)] });
  data.act({ ...ctx, type: 'record_card_view', word: apple });

  const before = data.store.snapshot();
  const openedAt = swiftTime(data.date);
  const openId = randomUUID().toUpperCase();
  const dictationId = openId.toLowerCase();
  const open = {
    requestId: openId,
    expectedRevision: before.revision,
    occurredAt: openedAt,
    action: { ...ctx, type: 'open_dictation', word: apple } as const,
  };

  // Capture all gestures before any commands reach the server.
  data.advance(2.5);
  const opened = data.store.command(open);
  assert.equal(opened.practice.activeDictationId, dictationId);
  assert.equal(opened.practice.dictations.at(-1)?.openedAt, openedAt);

  const submitted = ['  aple  ', 'APPLE'].map((answer, index) => {
    data.advance(2.5);
    const command = {
      requestId: randomUUID().toUpperCase(),
      expectedRevision: data.store.snapshot().revision,
      occurredAt: openedAt + (index + 1) / 10,
      action: { ...ctx, type: 'submit_dictation', dictationId: openId, answer } as const,
    };
    const result = data.store.command(command);
    assert.equal(data.store.command(command).revision, result.revision);
    return {
      id: command.requestId.toLowerCase(),
      answer,
      correct: index === 1,
      submittedAt: command.occurredAt,
    };
  });

  const closedAt = openedAt + 0.3;
  const closed = data.store.command({
    requestId: randomUUID(),
    expectedRevision: data.store.snapshot().revision,
    occurredAt: closedAt,
    action: { ...ctx, type: 'close_dictation', dictationId },
  });
  const practice = closed.practice.dictations.at(-1);
  assert.deepEqual(practice?.attempts, submitted);
  assert.equal(practice?.revealedAt, submitted[0]?.submittedAt);
  assert.equal(practice?.closedAt, closedAt);
  assert.equal(closed.practice.activeDictationId, null);
  assert.equal(closed.scheduling.visibleWord, null);
  assert.deepEqual(closed.ledger, before.ledger);
  assert.deepEqual(closed.scheduling.flow, before.scheduling.flow);
  assert.deepEqual(
    data.store.command(open),
    closed,
    'Replaying open after closure does not reopen the practice',
  );

  const visit = closed.ledger.days.at(-1)?.flow?.window.visit;
  assert.ok(visit);
  const prepared = data.store.command({
    requestId: randomUUID(),
    expectedRevision: closed.revision,
    occurredAt: openedAt + 0.4,
    action: { ...ctx, type: 'window_familiar', word: apple, visitId: visit.id },
  });
  const spelled = data.store.command({
    requestId: randomUUID(),
    expectedRevision: prepared.revision,
    occurredAt: openedAt + 0.5,
    action: {
      ...ctx,
      type: 'submit_spelling',
      word: apple,
      answer: 'apple',
      advanceOnCorrect: false,
    },
  });
  assert.equal(
    spelled.ledger.days.at(-1)?.learning?.spellingAttempts.at(-1)?.lastPotentialHelpAt,
    submitted.at(-1)?.submittedAt,
    'Formal spelling can follow a quick scratchpad exit before either scratchpad receipt arrives',
  );
  data.reopen();
  assert.deepEqual(data.store.snapshot(), spelled);
});

test('single-card dictation retains extra raw inputs and revelations without changing batch first answers or FSRS', async (t) => {
  const data = await fixture(t);
  data.act({ type: 'begin', target: 'daily', deck: [apple], timezone });
  const dayId = data.store.snapshot().planning.activeDayId;
  assert.ok(dayId);
  const ctx = { target: 'daily', dayId } as const;
  data.act({ ...ctx, type: 'add_sentences', sentences: [example(apple)] });
  data.act({ ...ctx, type: 'record_card_view', session: 'learning', word: apple });
  data.act({ ...ctx, type: 'mark_studied', word: apple, remainOnCard: true });
  assert.deepEqual(data.store.snapshot().ledger.days.at(-1)?.retainedLearningWord, apple);
  data.act({ ...ctx, type: 'open_dictation', session: 'learning', word: apple });
  const id = data.store.snapshot().practice.activeDictationId;
  assert.ok(id);
  data.act({ ...ctx, type: 'submit_dictation', dictationId: id, answer: '' });
  assert.equal(data.store.snapshot().practice.dictations[0]?.attempts[0]?.correct, false);
  assert.ok(
    data.store.snapshot().practice.dictations[0]?.revealedAt !== undefined,
    'A blank support attempt still reveals the reference after preserving the raw input',
  );
  data.act({ ...ctx, type: 'submit_dictation', dictationId: id, answer: '  aple  ' });
  data.act({ ...ctx, type: 'reveal_dictation', dictationId: id });
  data.act({ ...ctx, type: 'submit_dictation', dictationId: id, answer: 'APPLE' });
  let day = data.store.snapshot().ledger.days.at(-1);
  assert.equal(day?.learning?.spellingAttempts.length, 0);
  assert.equal(day?.scheduleUpdates.length, 0);
  assert.equal(miniMemory(data.store.snapshot(), apple)?.fsrs, null);
  data.act({ ...ctx, type: 'unmark_studied', word: apple });
  day = data.store.snapshot().ledger.days.at(-1);
  assert.equal(day?.studiedWords.length, 0);
  assert.deepEqual(
    day?.studyMarkEvents?.map((event) => event.remembered),
    [true, false],
  );
  assert.equal(data.store.snapshot().practice.activeDictationId, null);
  assert.deepEqual(
    data.store.snapshot().practice.dictations[0]?.attempts.map((item) => item.answer),
    ['', '  aple  ', 'APPLE'],
  );
  data.act({ ...ctx, type: 'mark_studied', word: apple, remainOnCard: true });
  assert.throws(
    () =>
      data.act({
        ...ctx,
        type: 'submit_spelling',
        session: 'learning',
        word: apple,
        answer: 'apple',
        advanceOnCorrect: true,
      }),
    'A retained card must leave before the whole-group spelling begins',
  );
  data.act({ ...ctx, type: 'advance_learning_card', word: apple });
  data.act({
    ...ctx,
    type: 'submit_spelling',
    session: 'learning',
    word: apple,
    answer: 'apple',
    advanceOnCorrect: true,
  });
  const batch = data.store.snapshot().ledger.days.at(-1)?.learning?.spellingAttempts;
  assert.equal(batch?.length, 1);
  assert.equal(batch?.[0]?.answer, 'apple');
  assert.ok(batch?.[0]?.lastPotentialHelpAt !== undefined);
  assert.throws(
    () => data.act({ ...ctx, type: 'unmark_studied', word: apple }),
    'Started whole-group facts cannot be undone by unmarking',
  );
});

test('undoing an unfinalized review judgment closes practice and archives its actual original selection', async (t) => {
  const data = await fixture(t);
  data.act({ type: 'begin', target: 'review', deck: [apple], timezone });
  const recordId = data.store.snapshot().reviewRecord?.id;
  assert.ok(recordId);
  const ctx = { target: 'review', recordId, word: apple } as const;
  data.act({ ...ctx, type: 'choose_judgment', judgment: 'clear' });
  data.act({ ...ctx, type: 'open_dictation' });
  data.act({ ...ctx, type: 'clear_judgment' });
  const record = data.store.snapshot().reviewRecord;
  assert.equal(record?.session.judgmentEvents.length, 0);
  assert.equal(record?.session.clearedJudgments?.[0]?.selected, 'clear');
  assert.equal(data.store.snapshot().practice.activeDictationId, null);
  data.act({ ...ctx, type: 'choose_judgment', judgment: 'fuzzy' });
  assert.equal(data.store.snapshot().reviewRecord?.session.judgmentEvents[0]?.selected, 'fuzzy');
  assert.equal(
    data.store.planPreview({ deck: [apple], timezone }).planContext.newCount,
    1,
    'Standalone support practice does not silently enroll the word or block explicit continuation into new-word learning',
  );
});

test('window scratch spelling requires a full card, retains repeated inputs and closes before the next word', async (t) => {
  const data = await fixture(t);
  data.act({
    type: 'begin',
    target: 'daily',
    deck: [apple, book],
    timezone,
    flowVersion: 'sliding-window-v2',
  });
  const dayId = data.store.snapshot().planning.activeDayId;
  assert.ok(dayId);
  const ctx = { target: 'daily', dayId, session: 'learning' } as const;
  data.act({
    target: 'daily',
    dayId,
    type: 'add_sentences',
    sentences: [example(apple), example(book)],
  });
  const stages = new Set<number>();
  for (let index = 0; index < 6; index++) {
    const visit = data.store.snapshot().ledger.days.at(-1)?.flow?.window.visit;
    assert.ok(visit);
    stages.add(visit.stage);
    const action = { ...ctx, word: visit.word, visitId: visit.id };
    if (visit.stage > 0) {
      assert.throws(() => data.act({ ...ctx, type: 'open_dictation', word: visit.word }));
      data.act({ ...action, type: 'window_choose', remembered: true });
    }
    const before = data.store.snapshot();
    assert.throws(() =>
      data.act({
        ...ctx,
        type: 'open_dictation',
        word: visit.word.spelling === apple.spelling ? book : apple,
      }),
    );
    data.act({ ...ctx, type: 'open_dictation', word: visit.word });
    const dictationId = data.store.snapshot().practice.activeDictationId;
    assert.ok(dictationId);
    data.act({ ...ctx, type: 'submit_dictation', dictationId, answer: 'wrong' });
    data.act({
      ...ctx,
      type: 'submit_dictation',
      dictationId,
      answer: `  ${visit.word.spelling.toUpperCase()}  `,
    });
    data.act({ ...ctx, type: 'submit_dictation', dictationId, answer: visit.word.spelling });
    const practiced = data.store.snapshot();
    assert.deepEqual(practiced.ledger.days.at(-1)?.flow, before.ledger.days.at(-1)?.flow);
    assert.deepEqual(practiced.scheduling.flow, before.scheduling.flow);
    assert.deepEqual(
      practiced.practice.dictations.at(-1)?.attempts.map((attempt) => attempt.correct),
      [false, true, true],
    );
    data.act({
      ...action,
      type: 'window_advance',
      ...(visit.stage === 0 ? { remembered: true } : {}),
    });
    assert.equal(data.store.snapshot().practice.activeDictationId, null);
    assert.ok(data.store.snapshot().practice.dictations.at(-1)?.closedAt !== undefined);
  }
  assert.deepEqual([...stages].sort(), [0, 1, 2]);
  const saved = data.store.snapshot();
  data.reopen();
  assert.deepEqual(data.store.snapshot(), saved);
});

test('explicit new-course grouping preserves and pauses old facts; an empty or conflicting new scope is atomic', async (t) => {
  const data = await fixture(t);
  data.act({ type: 'begin', target: 'daily', deck: [apple], timezone });
  const original = structuredClone(data.store.snapshot().ledger.days[0]);
  assert.ok(original);
  data.act({ type: 'begin', target: 'daily', deck: [apple, book], timezone, newGroup: true });
  const next = data.store.snapshot();
  assert.equal(next.ledger.days.length, 2);
  assert.equal(next.ledger.days[0]?.paused, true);
  assert.deepEqual(next.ledger.days[0]?.studiedWords, original.studiedWords);
  assert.deepEqual(next.ledger.days[0]?.learning, original.learning);
  assert.deepEqual(next.ledger.days[1]?.learningWords, [book]);
  assert.notEqual(next.planning.activeDayId, original.id);
  assert.throws(() =>
    data.act({ type: 'begin', target: 'daily', deck: [apple, book], timezone, newGroup: true }),
  );
  assert.deepEqual(data.store.snapshot(), next);
  assert.throws(() =>
    data.act({
      type: 'begin',
      target: 'daily',
      deck: [book],
      timezone,
      newGroup: true,
      dayId: original.id,
    }),
  );
  assert.deepEqual(data.store.snapshot(), next);
});

test('authenticated HTTP keeps uncertain replies idempotent and pending probes survive SQLite reopening without model inference', async (t) => {
  const data = await fixture(t);
  const token = 'isolated-measurement-http-token-123456789';
  const app = buildApp({ mini: { store: data.store, token } });
  const before = data.store.snapshot();
  const command = miniCommandSchema.parse({
    requestId: randomUUID(),
    expectedRevision: before.revision,
    action: { type: 'begin_probe', target: 'daily', word: apple },
  });
  const call = () =>
    app.inject({
      method: 'POST',
      url: '/api/mini/commands',
      headers: { authorization: 'Bearer ' + token },
      payload: command,
    });
  const first = await call(),
    replay = await call();
  assert.equal(first.statusCode, 200);
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(first.json(), replay.json());
  const saved = data.store.snapshot();
  data.reopen();
  assert.deepEqual(data.store.snapshot(), saved);
  assert.equal(data.probe().status, 'active');
  assert.equal(miniMemory(data.store.snapshot(), apple)?.fsrs, null);
  data.act({ type: 'end_probe', target: 'daily', probeId: data.probe().id });
  assert.equal(data.probe().classification, undefined, 'Leaving without an answer is never Again');
  await app.close();
  const reconnected = buildApp({ mini: { store: data.store, token } });
  try {
    const http = (payload: unknown) =>
      reconnected.inject({
        method: 'POST',
        url: '/api/mini/commands',
        headers: { authorization: 'Bearer ' + token },
        payload: miniCommandSchema.parse(payload),
      });
    const started = await http({
      requestId: randomUUID(),
      expectedRevision: data.store.snapshot().revision,
      action: { type: 'begin_probe', target: 'daily', word: book },
    });
    assert.equal(started.statusCode, 200);
    const submission = {
      requestId: randomUUID(),
      expectedRevision: data.store.snapshot().revision,
      action: {
        type: 'submit_probe',
        target: 'daily',
        probeId: data.probe().id,
        answer: '  BOOK  ',
      },
    };
    const answered = await http(submission),
      retried = await http(submission);
    assert.equal(answered.statusCode, 200);
    assert.deepEqual(answered.json(), retried.json());
    assert.equal(data.probe().rating, 'Good');
    assert.equal(miniMemory(data.store.snapshot(), book)?.fsrs?.reps, 1);
  } finally {
    await reconnected.close();
  }
});

test('unrated targets retain unknown recall and every fifth actual position reserves the oldest waiting target without mutating facts', async (t) => {
  const data = await fixture(t);
  data.begin(apple);
  data.answer('apple');
  data.end();
  const scheduling = structuredClone(data.store.snapshot().scheduling);
  const scheduled = scheduling.cards[0];
  assert.ok(scheduled);
  const unknown = {
    ...scheduled,
    senseId: 'unknown-fixture',
    word: book,
    fsrs: null,
    state: 'introduced' as const,
    dueAt: scheduled.dueAt - 1,
    lastServedAt: null,
  };
  scheduling.cards.push(unknown);
  const items = [
    { word: apple, schedule: { dueAt: scheduled.dueAt } },
    { word: book, schedule: { dueAt: unknown.dueAt } },
  ];
  const before = structuredClone(scheduling);
  assert.deepEqual(orderMiniDue(items, scheduling, scheduled.dueAt + 100)[0]?.word, apple);
  assert.deepEqual(scheduling, before);
  scheduling.servedCount = 4;
  assert.deepEqual(orderMiniDue(items, scheduling, scheduled.dueAt + 100)[0]?.word, book);
  assert.equal(defaultMiniScheduling().cards.length, 0);
});

test('a 300-word backlog preserves the per-turn priority and fifth-slot waiting order across group boundaries', () => {
  const scheduling = defaultMiniScheduling();
  const items = Array.from({ length: 300 }, (_, i) => {
    const word = {
      spelling: 'term' + i.toString().padStart(3, '0'),
      meaning: '单词',
      phonetic: '',
    };
    const dueAt = 100 + (i % 13);
    const lastServedAt = i % 3 === 0 ? dueAt + 10 : null;
    const priority = i % 6;
    scheduling.cards.push({
      senseId:
        'sense-' +
        createHash('sha256')
          .update(JSON.stringify([word.spelling, word.meaning]))
          .digest('hex'),
      word,
      introducedAt: 0,
      dueAt,
      lastServedAt,
      practicePriority: priority,
      ability: 'spelling',
      exposureKnown: true,
      lastAnswerExposureAt: null,
      state: 'introduced',
      fsrs: null,
    });
    return {
      word,
      schedule: { dueAt },
      waiting: Math.max(dueAt, lastServedAt ?? -Infinity),
      priority,
    };
  });
  for (const offset of [0, 3, 4]) {
    scheduling.servedCount = offset;
    const pool = items.slice().reverse();
    const result = orderMiniDue(pool, scheduling, 200);
    for (const [i, selected] of result.entries()) {
      const reserveOldest = (offset + i + 1) % 5 === 0;
      pool.sort(
        (a, b) =>
          (reserveOldest ? 0 : b.priority - a.priority) ||
          a.waiting - b.waiting ||
          a.word.spelling.localeCompare(b.word.spelling),
      );
      assert.equal(selected, pool.shift());
    }
    assert.equal(pool.length, 0);
  }
});

test('legacy migration uses recorded exposure without inventing model reviews or forcing an extra card view', async (t) => {
  const data = await fixture(t);
  data.act({ type: 'begin', target: 'review', deck: [apple], timezone });
  const recordId = data.store.snapshot().reviewRecord?.id;
  assert.ok(recordId);
  data.act({ type: 'choose_judgment', target: 'review', recordId, word: apple, judgment: 'clear' });
  const source = data.store.snapshot();
  let date = new Date(data.date.getTime() + 300_000);
  const migrated = new MiniStore(':memory:', { now: () => date, timezone });
  t.after(() => migrated.close());
  migrated.importLegacy({
    requestId: randomUUID(),
    ledger: source.ledger,
    reviewRecord: source.reviewRecord,
    reviewHistory: source.reviewHistory,
    timezone,
  });
  assert.deepEqual(migrated.snapshot().ledger, source.ledger);
  assert.deepEqual(migrated.snapshot().reviewRecord, source.reviewRecord);
  assert.equal(miniMemory(migrated.snapshot(), apple)?.fsrs, null);
  assert.equal(miniMemory(migrated.snapshot(), apple)?.lastAnswerExposureAt, swiftTime(data.date));
  function act(action: MiniAction) {
    return migrated.command(
      miniCommandSchema.parse({
        requestId: randomUUID(),
        expectedRevision: migrated.snapshot().revision,
        action,
      }),
    );
  }
  act({ type: 'begin_probe', target: 'daily', word: apple });
  const id = migrated.snapshot().scheduling.activeProbeId;
  assert.ok(id);
  act({ type: 'submit_probe', target: 'daily', probeId: id, answer: 'apple' });
  assert.equal(migrated.snapshot().scheduling.probes.at(-1)?.rating, 'Good');
  assert.deepEqual(migrated.snapshot().reviewRecord, source.reviewRecord);
  const fixed = structuredClone(migrated.snapshot().scheduling.cards);
  date = new Date(date.getTime() + 30 * 86_400_000);
  migrated.planPreview({ deck: [apple], timezone });
  assert.deepEqual(
    migrated.snapshot().scheduling.cards,
    fixed,
    'Elapsed absence never invents failures or changes D/S',
  );
});

test('same-clock pre-probe exposure is too soon, while an actual in-probe view records support and other learning stays frozen', async (t) => {
  const data = await fixture(t);
  data.act({ type: 'begin', target: 'daily', deck: [apple], timezone });
  const dayId = data.store.snapshot().planning.activeDayId;
  assert.ok(dayId);
  data.act({ type: 'add_sentences', target: 'daily', dayId, sentences: [example(apple)] });
  data.act({ type: 'record_card_view', target: 'daily', dayId, session: 'learning', word: apple });
  const originalGroup = structuredClone(data.store.snapshot().ledger);
  data.begin();
  assert.throws(() => data.act({ type: 'mark_studied', target: 'daily', dayId, word: apple }));
  assert.deepEqual(data.store.snapshot().ledger, originalGroup);
  assert.equal(
    data.answer('apple').classification,
    'too_soon',
    'Ordering provenance distinguishes exposure before open from help during the probe at an identical clock value',
  );
  data.end();
  data.advance(300);
  data.begin();
  data.act({
    type: 'record_card_view',
    target: 'daily',
    word: { ...apple, meaning: '同拼写的另一个词义' },
  });
  assert.equal(data.answer('apple').classification, 'supported');
  assert.equal(data.probe().rating, undefined);
  assert.equal(miniMemory(data.store.snapshot(), apple)?.fsrs, null);
  data.end();
  data.advance(300);
  data.act({ type: 'record_card_view', target: 'daily', word: apple });
  data.advance(300);
  data.begin();
  assert.equal(
    data.answer('apple').classification,
    'too_soon',
    'Five minutes staring at visible English is not five minutes of independent recall delay',
  );
});

test('a queued study-card view keeps its display time and does not reopen an already hidden card', async (t) => {
  const data = await fixture(t);
  data.act({ type: 'begin', target: 'daily', deck: [apple], timezone });
  const dayId = data.store.snapshot().planning.activeDayId;
  assert.ok(dayId);
  data.act({ type: 'add_sentences', target: 'daily', dayId, sentences: [example(apple)] });
  const recordView = (occurredAt: number) =>
    data.store.command(
      miniCommandSchema.parse({
        requestId: randomUUID(),
        expectedRevision: data.store.snapshot().revision,
        occurredAt,
        action: {
          type: 'record_card_view',
          target: 'daily',
          dayId,
          session: 'learning',
          word: apple,
        },
      }),
    );
  data.advance(2);
  const shown = swiftTime(data.date);
  data.advance(3);
  const first = recordView(shown);
  assert.equal(first.teaching.exposures.at(-1)?.at, shown);
  assert.equal(first.teaching.exposures.at(-1)?.beforeAttemptCount, 0);
  assert.equal(miniMemory(first, apple)?.lastAnswerExposureAt, shown);
  assert.deepEqual(first.scheduling.visibleWord, apple);
  const hidden = swiftTime(data.date);
  data.act({ type: 'hide_card', target: 'daily', word: apple });
  data.advance(10);
  const late = recordView(shown + 1);
  assert.equal(late.scheduling.views.at(-1)?.at, shown + 1);
  assert.equal(late.scheduling.visibleWord, null);
  assert.equal(miniMemory(late, apple)?.lastAnswerExposureAt, hidden);
  const now = swiftTime(data.date);
  assert.equal(recordView(now + 2).teaching.exposures.at(-1)?.at, now);
});

test('delayed hide receipts preserve their actual time and cannot close a later visit to the same word', async (t) => {
  await t.test('a recovered hide retains the real hidden recall interval', async (child) => {
    const data = await fixture(child);
    const shown = data.act({ type: 'record_card_view', target: 'daily', word: apple });
    data.advance(10);
    const hiddenAt = swiftTime(data.date);
    const hide = miniCommandSchema.parse({
      requestId: randomUUID(),
      expectedRevision: shown.revision,
      occurredAt: hiddenAt,
      action: { type: 'hide_card', target: 'daily', word: apple },
    });
    data.advance(300);
    const later = data.act({ type: 'record_browse_views', target: 'daily', words: [book] });
    assert.ok(later.revision > hide.expectedRevision);
    const closed = data.store.command(hide);
    assert.equal(closed.scheduling.visibleWord, null);
    assert.equal(closed.scheduling.views.at(-1)?.at, hiddenAt);
    data.reopen();
    assert.deepEqual(data.store.command(hide), closed);
    assert.throws(() => data.store.command({ ...hide, expectedRevision: later.revision }), {
      code: 'REQUEST_CONFLICT',
    });
    data.begin();
    assert.equal(data.answer('apple').classification, 'independent_success');
    assert.equal(data.probe().measurement?.lastAnswerExposureAt, hiddenAt);
  });
  await t.test('an old hide cannot clear a new visible visit to the same answer', async (child) => {
    const data = await fixture(child);
    const shown = data.act({ type: 'record_card_view', target: 'daily', word: apple });
    data.advance(10);
    const oldHiddenAt = swiftTime(data.date);
    data.advance(300);
    data.act({ type: 'record_card_view', target: 'daily', word: apple });
    const current = structuredClone(data.store.snapshot().scheduling);
    data.store.command(
      miniCommandSchema.parse({
        requestId: randomUUID(),
        expectedRevision: shown.revision,
        occurredAt: oldHiddenAt,
        action: { type: 'hide_card', target: 'daily', word: apple },
      }),
    );
    assert.deepEqual(data.store.snapshot().scheduling, current);
    data.advance(300);
    data.begin();
    assert.equal(data.answer('apple').classification, 'too_soon');
    assert.equal(data.probe().rating, undefined);
  });
  await t.test(
    'switching words before delivery quietly acknowledges only a dated past hide',
    async (child) => {
      const data = await fixture(child);
      const shown = data.act({ type: 'record_card_view', target: 'daily', word: apple });
      data.advance(1);
      const occurredAt = swiftTime(data.date);
      data.advance(1);
      const next = data.act({ type: 'record_card_view', target: 'daily', word: book });
      const base = { expectedRevision: shown.revision, occurredAt };
      const hide = miniCommandSchema.parse({
        ...base,
        requestId: randomUUID(),
        action: { type: 'hide_card', target: 'daily', word: apple },
      });
      assert.deepEqual(data.store.command(hide), next);
      assert.deepEqual(data.store.commandReceipt(hide.requestId), {
        requestId: hide.requestId,
        revision: next.revision,
      });
      for (const input of [
        { ...hide, occurredAt: undefined },
        { ...hide, expectedRevision: next.revision + 1 },
        { ...hide, action: { type: 'record_card_view', target: 'daily', word: apple } },
      ]) {
        const command = miniCommandSchema.parse({ ...input, requestId: randomUUID() });
        assert.throws(() => data.store.command(command), { code: 'MINI_REVISION_CONFLICT' });
      }
      assert.deepEqual(data.store.snapshot(), next);
    },
  );
});
