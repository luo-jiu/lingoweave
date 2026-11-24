import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  defaultMiniPlanning,
  miniCommandSchema,
  miniPlanPreviewSchema,
  type MiniAction,
  type MiniCommand,
  type MiniWord,
} from '@lingoweave/contracts';
import { z } from 'zod';
import { LearningError } from './learning-store.js';
import { MiniStore } from './mini-store.js';
import { currentTranslation, miniCandidates, swiftTime } from './mini-study.js';

const timezone = 'Asia/Shanghai';
const words: MiniWord[] = [
  { spelling: 'apple', meaning: '苹果', phonetic: '' },
  { spelling: 'book', meaning: '书', phonetic: '' },
  { spelling: 'water', meaning: '水', phonetic: '' },
  { spelling: 'home', meaning: '家', phonetic: '' },
  { spelling: 'friend', meaning: '朋友', phonetic: '' },
];
const apple = words[0];
const book = words[1];
assert.ok(apple && book);
const limits = { wordLimit: 10, newWordLimit: 5 };
const hasCode = (code: string) => (error: unknown) =>
  error instanceof LearningError && error.code === code;
function fixture(t: TestContext, filename = ':memory:') {
  let date = new Date('2026-11-13T04:00:00Z');
  let store = new MiniStore(filename, { now: () => date, timezone });
  t.after(() => store.close());
  store.importLegacy({
    requestId: randomUUID(),
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
    timezone,
  });
  const act = (action: z.input<typeof miniCommandSchema>['action']) =>
    store.command(
      miniCommandSchema.parse({
        requestId: randomUUID(),
        expectedRevision: store.snapshot().revision,
        action,
      }),
    );
  const day = () => {
    const snapshot = store.snapshot();
    const result = snapshot.ledger.days.find((item) => item.id === snapshot.planning.activeDayId);
    assert.ok(result);
    return result;
  };
  return {
    get store() {
      return store;
    },
    act,
    day,
    begin(deck = words, extra: { recovery?: boolean; overrideRest?: boolean } = {}) {
      return act({ type: 'begin', target: 'daily', deck, timezone, ...extra });
    },
    context() {
      return miniPlanPreviewSchema.parse(store.planPreview({ deck: words, timezone })).planContext;
    },
    setDate(value: string) {
      date = new Date(value);
    },
    today(mode: 'normal' | 'reviewOnly' | 'rest', overrides: Partial<typeof limits> = {}) {
      return act({
        type: 'set_today_plan',
        target: 'daily',
        date: store.planPreview({ deck: words, timezone }).planContext.date,
        timezone,
        mode,
        ...limits,
        ...overrides,
      });
    },
    reopen() {
      store.close();
      store = new MiniStore(filename, { now: () => date, timezone });
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
function daily(data: Fixture) {
  return { target: 'daily' as const, dayId: data.day().id };
}
function addSentences(data: Fixture) {
  const missing = data
    .day()
    .learningWords.filter(
      (word) => !data.day().sentences.some((sentence) => sentence.word.spelling === word.spelling),
    );
  if (missing.length)
    data.act({
      ...daily(data),
      type: 'add_sentences',
      sentences: missing.map((word) => ({
        word,
        english: `I see ${word.spelling}.`,
        chinese: `我看见${word.meaning}。`,
      })),
    });
}
function finishReview(data: Fixture) {
  const ctx = daily(data);
  if (data.day().phase === 'review') {
    for (const word of data.day().reviewWords) {
      data.act({ ...ctx, type: 'choose_judgment', session: 'review', word, judgment: 'clear' });
      data.act({ ...ctx, type: 'advance_judgment', session: 'review', word });
    }
    for (const word of data.day().review?.queue ?? [])
      data.act({ ...ctx, type: 'submit_spelling', session: 'review', word, answer: word.spelling });
    data.act({ ...ctx, type: 'complete_review' });
  }
}
function finish(data: Fixture) {
  const ctx = daily(data);
  finishReview(data);
  if (data.day().phase === 'learning') {
    addSentences(data);
    for (const word of data.day().learningWords) data.act({ ...ctx, type: 'mark_studied', word });
    for (const word of data.day().learning?.queue ?? [])
      data.act({
        ...ctx,
        type: 'submit_spelling',
        session: 'learning',
        word,
        answer: word.spelling,
      });
    data.act({ ...ctx, type: 'complete_learning' });
  }
  const preparedDay = data.day();
  const prompts = [...preparedDay.reviewWords, ...preparedDay.learningWords].flatMap(
    (word, index) => {
      const direction = preparedDay.directions[index];
      return direction &&
        !preparedDay.writingPrompts?.some((item) => item.sentence.word.meaning === word.meaning)
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
    },
  );
  if (prompts.length && preparedDay.writingRequired !== false)
    data.act({ ...ctx, type: 'publish_writing', prompts });
  for (let index = 0; index < 10; index += 1) {
    const task = currentTranslation(data.day());
    if (!task) break;
    data.act({ ...ctx, type: 'submit_translation', taskId: task.id, answer: '原始回答' });
    const attempt = data.day().translation.at(-1);
    assert.ok(attempt);
    data.act({
      ...ctx,
      type: 'record_feedback',
      attemptId: attempt.id,
      feedback: {
        outcome: 'partial',
        comment: '意思明确',
        tip: '留意表达',
        usefulPhrase: 'a short break',
      },
    });
    data.act({ ...ctx, type: 'advance_translation', taskId: task.id });
  }
}

test('plan preview is read-only and a today-only rest expires without debt or learning events', (t) => {
  const data = fixture(t);
  const initial = data.store.snapshot();
  const preview = data.context();
  assert.equal(preview.newCount, 5);
  assert.equal(preview.lastActivityAt, null);
  assert.deepEqual(data.store.snapshot(), initial);
  data.today('rest');
  assert.equal(data.context().canStart, false);
  assert.throws(() => data.begin(), hasCode('MINI_PLAN_CONFLICT'));
  assert.deepEqual(data.store.snapshot().ledger.days, []);
  data.setDate('2026-11-14T04:00:00Z');
  const next = data.context();
  assert.equal(next.todayOverride, null);
  assert.deepEqual(next.effective, { mode: 'normal', ...limits, dailyNewGoal: 5, groupSize: 20 });
  data.begin();
  assert.equal(data.day().learningWords.length, 5);
  assert.deepEqual(data.day().scheduleUpdates, []);
  assert.equal(data.store.snapshot().planning.dailyOverrides.length, 1);
});

test('committed plan retries retain their original date across midnight; uncommitted stale dates reject', (t) => {
  const data = fixture(t);
  data.setDate('2026-11-13T15:59:00Z');
  const command: MiniCommand = miniCommandSchema.parse({
    requestId: randomUUID(),
    expectedRevision: data.store.snapshot().revision,
    action: {
      type: 'set_today_plan',
      target: 'daily',
      date: '2026-11-13',
      timezone,
      mode: 'rest',
      ...limits,
    },
  });
  const accepted = data.store.command(command);
  data.setDate('2026-11-13T16:01:00Z');
  assert.deepEqual(data.store.command(command), accepted);
  assert.equal(data.context().todayOverride, null);
  assert.throws(
    () =>
      data.store.command({
        ...command,
        requestId: randomUUID(),
        expectedRevision: accepted.revision,
      }),
    hasCode('MINI_PLAN_CONFLICT'),
  );
  assert.deepEqual(data.store.snapshot(), accepted);
});

test('long-term weekdays govern new work and an explicit rest-day exception lasts for the current budget', (t) => {
  const data = fixture(t);
  data.act({ type: 'set_long_term_plan', target: 'daily', plan: { weekdays: [1], ...limits } });
  assert.equal(data.context().effective.mode, 'rest');
  data.begin([apple], { overrideRest: true });
  addSentences(data);
  data.act({ ...daily(data), type: 'mark_studied', word: apple });
  assert.equal(data.day().paused, false);
  data.act({
    ...daily(data),
    type: 'submit_spelling',
    session: 'learning',
    word: apple,
    answer: 'apple',
  });
  assert.equal(data.day().paused, false);
  assert.equal(data.store.snapshot().planning.sessions.at(-1)?.overrideRest, true);
});

test('session capacity preserves a five-word group and pauses before a new word, while a one-word group can finish', (t) => {
  const data = fixture(t);
  data.begin();
  addSentences(data);
  const originalWords = data.day().learningWords;
  const originalQueue = data.day().learning?.queue;
  data.act({
    type: 'set_session_plan',
    target: 'daily',
    wordLimit: 1,
    newWordLimit: 1,
  });
  data.act({ ...daily(data), type: 'mark_studied', word: apple });
  assert.equal(data.day().paused, true);
  assert.deepEqual(data.day().learningWords, originalWords);
  assert.deepEqual(data.day().learning?.queue, originalQueue);
  assert.deepEqual(data.day().scheduleUpdates, []);
  assert.equal(data.store.snapshot().planning.sessions.at(-1)?.pauseReason, 'budget');
  data.begin();
  assert.equal(data.day().paused, false);
  assert.equal(data.day().studiedWords.length, 1);

  const single = fixture(t);
  single.act({
    type: 'set_session_plan',
    target: 'daily',
    wordLimit: 1,
    newWordLimit: 1,
  });
  single.begin([apple]);
  finish(single);
  assert.equal(single.day().phase, 'finished');
  assert.equal(single.store.snapshot().planning.sessions.at(-1)?.servedWords.length, 1);
});

test('new-word limit applies to an existing group but already-studied words may continue support practice', (t) => {
  const data = fixture(t);
  data.begin();
  addSentences(data);
  data.act({
    type: 'set_session_plan',
    target: 'daily',
    wordLimit: 10,
    newWordLimit: 1,
  });
  data.act({ ...daily(data), type: 'mark_studied', word: apple });
  assert.equal(data.day().paused, true);
  data.act({
    type: 'set_session_plan',
    target: 'daily',
    wordLimit: 10,
    newWordLimit: 0,
  });
  data.begin();
  assert.equal(data.day().paused, true);
  assert.equal(data.day().studiedWords.length, 1);

  const studied = fixture(t);
  studied.begin([apple]);
  addSentences(studied);
  studied.act({ ...daily(studied), type: 'mark_studied', word: apple });
  studied.act({
    type: 'set_session_plan',
    target: 'daily',
    wordLimit: 1,
    newWordLimit: 0,
  });
  assert.equal(studied.day().paused, false);
  studied.act({
    ...daily(studied),
    type: 'submit_spelling',
    session: 'learning',
    word: apple,
    answer: 'apple',
  });
  assert.equal(studied.day().learning?.phase, 'finished');
});

test('different senses of the same spelling share word capacity while their learning facts remain separate', (t) => {
  const data = fixture(t);
  const anotherSense = { ...book, meaning: '预订' };
  data.act({
    type: 'set_session_plan',
    target: 'daily',
    wordLimit: 1,
    newWordLimit: 1,
  });
  data.begin([book, anotherSense]);
  finish(data);
  assert.equal(data.day().phase, 'finished');
  assert.equal(data.day().studiedWords.length, 2);
  assert.equal(data.day().learning?.spellingAttempts.length, 2);
  assert.equal(data.store.snapshot().planning.sessions.at(-1)?.servedWords.length, 1);
  assert.equal(data.store.snapshot().planning.sessions.at(-1)?.newWords?.length, 1);
});

test('long idle gaps do not pause spelling or discard the original and corrected answers', (t) => {
  const data = fixture(t);
  data.begin([book, apple]);
  addSentences(data);
  for (const word of data.day().learningWords)
    data.act({ ...daily(data), type: 'mark_studied', word });
  data.act({ type: 'set_session_plan', target: 'daily', ...limits });
  data.setDate('2026-11-13T15:30:00Z');
  data.act({
    ...daily(data),
    type: 'submit_spelling',
    session: 'learning',
    word: apple,
    answer: 'aplpe',
  });
  assert.equal(data.day().paused, false);
  data.act({
    ...daily(data),
    type: 'submit_spelling',
    session: 'learning',
    word: apple,
    answer: 'apple',
  });
  assert.equal(data.day().paused, false);
  assert.equal(data.day().learning?.spellingAttempts[0]?.answer, 'aplpe');
  assert.equal(data.day().learning?.spellingAttempts[1]?.answer, 'apple');
  assert.equal(data.day().learning?.queue[0]?.spelling, 'book');
});

test('rest and early ending retain existing material, original progress and true due dates', (t) => {
  const data = fixture(t);
  data.begin([apple]);
  addSentences(data);
  data.act({ ...daily(data), type: 'mark_studied', word: apple });
  const facts = data.day();
  data.today('rest');
  const paused = data.day();
  assert.equal(paused.paused, true);
  assert.deepEqual(paused.learning, facts.learning);
  assert.deepEqual(paused.sentences, facts.sentences);
  assert.deepEqual(paused.studiedWords, facts.studiedWords);
  assert.deepEqual(paused.scheduleUpdates, facts.scheduleUpdates);
  data.today('normal');
  data.begin();
  data.act({ ...daily(data), type: 'end_session' });
  assert.equal(data.day().phase, 'learning');
  assert.equal(data.day().paused, true);
  assert.equal(data.store.snapshot().planning.sessions.at(-1)?.pauseReason, 'ended');
});

test('review-only new groups finish without fabricated writing; old learning stays pending', (t) => {
  const data = fixture(t);
  data.begin([apple]);
  finish(data);
  const original = data.day();
  data.setDate('2026-11-16T04:00:00Z');
  data.today('reviewOnly');
  data.begin();
  assert.deepEqual(data.day().reviewWords, [apple]);
  assert.deepEqual(data.day().learningWords, []);
  assert.equal(data.day().writingRequired, false);
  finish(data);
  assert.equal(data.day().phase, 'finished');
  assert.equal(data.day().translationStartedAt, undefined);
  assert.deepEqual(data.day().translation, []);
  assert.equal(data.day().scheduleUpdates.length, 1);
  assert.deepEqual(data.store.snapshot().ledger.days[0], original);
  data.setDate('2026-11-17T04:00:00Z');
  assert.equal(data.context().pendingDayId, null);

  const pending = fixture(t);
  pending.begin();
  const before = pending.day();
  pending.today('reviewOnly');
  assert.equal(pending.context().canContinue, false);
  assert.equal(pending.day().paused, true);
  assert.deepEqual(pending.day().learningWords, before.learningWords);
  assert.throws(() => pending.begin(), hasCode('MINI_PLAN_CONFLICT'));
});

test('absence uses real activity and recovery caps the current budget for a fresh group with the original facts preserved', (t) => {
  const data = fixture(t);
  data.begin();
  addSentences(data);
  assert.equal(data.context().lastActivityAt, null);
  data.act({ ...daily(data), type: 'mark_studied', word: apple });
  const originalWords = data.day().learningWords;
  const oldId = data.day().id;
  const originalAt = swiftTime(new Date('2026-11-13T04:00:00Z'));
  data.setDate('2026-11-17T04:00:00Z');
  data.today('normal');
  const preview = data.context();
  assert.equal(preview.lastActivityAt, originalAt);
  assert.equal(preview.absenceDays, 4);
  assert.equal(preview.recoverySuggested, true);
  assert.equal(preview.recoveryWordLimit, 3);
  data.begin(words, { recovery: true });
  assert.notEqual(data.day().id, oldId);
  assert.deepEqual(data.day().learningWords, originalWords.slice(0, 3));
  assert.deepEqual(data.day().studiedWords, []);
  assert.deepEqual(
    data.store
      .snapshot()
      .ledger.days.find((day) => day.id === oldId)
      ?.studiedWords.map((item) => item.word),
    [apple],
  );
  assert.equal(data.store.snapshot().planning.sessions.at(-1)?.wordLimit, 3);
  assert.deepEqual(data.day().scheduleUpdates, []);
  data.act({ ...daily(data), type: 'mark_studied', word: apple });
  assert.equal(data.context().absenceDays, 0);
});

test('daily capacity expires at the local day boundary even if a previous budget is still open', (t) => {
  const data = fixture(t);
  data.today('normal', { wordLimit: 1 });
  data.begin([apple]);
  assert.equal(data.context().effective.wordLimit, 1);
  data.setDate('2026-11-13T16:01:00Z');
  assert.equal(data.context().effective.wordLimit, 10);
  assert.equal(data.context().todayOverride, null);
  assert.throws(
    () => data.act({ ...daily(data), type: 'mark_studied', word: apple }),
    hasCode('MINI_PLAN_CONFLICT'),
  );
  data.begin([apple]);
  addSentences(data);
  data.act({ ...daily(data), type: 'mark_studied', word: apple });
  assert.equal(data.store.snapshot().planning.sessions.at(-1)?.wordLimit, 10);
  assert.equal(
    data.store.snapshot().planning.sessions[0]?.endedAt,
    swiftTime(new Date('2026-11-13T16:01:00Z')),
  );
});

test('plan commands preserve idempotency/version checks and reject invalid dates or capacities', (t) => {
  const data = fixture(t);
  const action: MiniAction = {
    type: 'set_session_plan',
    target: 'daily',
    wordLimit: 1,
    newWordLimit: 1,
  };
  const command = {
    requestId: randomUUID(),
    expectedRevision: data.store.snapshot().revision,
    action,
  };
  const accepted = data.store.command(command);
  assert.deepEqual(data.store.command(command), accepted);
  assert.throws(
    () => data.store.command({ ...command, requestId: randomUUID() }),
    hasCode('MINI_REVISION_CONFLICT'),
  );
  assert.throws(() => miniCommandSchema.parse({ ...command, action: { ...action, wordLimit: 0 } }));
  assert.throws(() =>
    miniCommandSchema.parse({
      ...command,
      action: {
        type: 'set_today_plan',
        target: 'daily',
        date: '2026-02-30',
        timezone,
        mode: 'normal',
        ...limits,
      },
    }),
  );
});

test('explicit session settings survive today edits and an ordinary return to the same active group', (t) => {
  const data = fixture(t);
  data.begin([apple, book]);
  data.act({
    type: 'set_session_plan',
    target: 'daily',
    wordLimit: 1,
    newWordLimit: 1,
  });
  const active = data.store.snapshot().planning.sessions.at(-1);
  assert.ok(active);
  data.today('normal');
  data.act({ type: 'clear_today_plan', target: 'daily', date: '2026-11-13', timezone });
  data.begin([apple, book]);
  const continued = data.store.snapshot().planning.sessions.at(-1);
  assert.equal(continued?.id, active.id);
  assert.equal(continued?.startedAt, active.startedAt);
  assert.equal(continued?.wordLimit, 1);
  assert.equal(continued?.source, 'session');
  addSentences(data);
  data.act({ ...daily(data), type: 'mark_studied', word: apple });
  assert.equal(data.day().paused, true);
});

test('a new-day session edit is not consumed by the expired previous-day timer', (t) => {
  const data = fixture(t);
  data.today('normal', { wordLimit: 1 });
  data.begin([apple]);
  data.setDate('2026-11-14T04:00:00Z');
  data.act({
    type: 'set_session_plan',
    target: 'daily',
    wordLimit: 1,
    newWordLimit: 1,
  });
  assert.deepEqual(data.store.snapshot().planning.nextSessionOverride, {
    wordLimit: 1,
    newWordLimit: 1,
  });
  data.begin([apple]);
  assert.equal(data.day().paused, false);
  assert.equal(data.store.snapshot().planning.sessions.at(-1)?.wordLimit, 1);
  assert.equal(
    data.store.snapshot().planning.sessions.at(-1)?.startedAt,
    swiftTime(new Date('2026-11-14T04:00:00Z')),
  );
});

test('review-only work can run beside a preserved learning group and explicitly resume its exact original position', (t) => {
  const data = fixture(t);
  const more: MiniWord[] = Array.from({ length: 5 }, (_, index) => ({
    spelling: `known${index}`,
    meaning: `已知词${index}`,
    phonetic: '',
  }));
  const newWord: MiniWord = { spelling: 'morning', meaning: '早晨', phonetic: '' };
  data.begin(words);
  finish(data);
  data.begin(more);
  finish(data);
  assert.equal(data.store.snapshot().ledger.days.length, 2);
  assert.notEqual(
    data.store.snapshot().ledger.days[0]?.id,
    data.store.snapshot().ledger.days[1]?.id,
  );
  data.setDate('2026-11-16T04:00:00Z');
  data.begin([...words, ...more, newWord]);
  finishReview(data);
  assert.equal(data.day().phase, 'learning');
  const originalId = data.day().id;
  data.today('reviewOnly');
  const preserved = data.day();
  const overview = data.store.planPreview({
    deck: [...words, ...more, newWord],
    timezone,
  }).planContext;
  assert.equal(overview.dueCount, 5);
  assert.equal(overview.canStart, true);
  assert.equal(overview.pendingDayId, null);
  assert.equal(
    overview.pendingGroups.find((group) => group.dayId === originalId)?.canContinue,
    false,
  );
  data.begin([...words, ...more, newWord]);
  const reviewId = data.day().id;
  assert.notEqual(reviewId, originalId);
  assert.ok(reviewId.startsWith('2026-11-16~'));
  assert.deepEqual(
    data
      .day()
      .reviewWords.map((word) => word.spelling)
      .sort(),
    [...words, ...more]
      .filter(
        (word) => !preserved.reviewWords.some((previous) => previous.spelling === word.spelling),
      )
      .map((word) => word.spelling)
      .sort(),
  );
  assert.equal(data.day().writingRequired, false);
  assert.deepEqual(
    data.store.snapshot().ledger.days.find((day) => day.id === originalId),
    preserved,
  );
  finish(data);
  assert.equal(data.day().phase, 'finished');
  data.today('normal');
  data.act({
    type: 'begin',
    target: 'daily',
    deck: [...words, ...more, newWord],
    timezone,
    dayId: originalId,
  });
  assert.equal(data.store.snapshot().planning.activeDayId, originalId);
  assert.equal(data.day().phase, 'learning');
  assert.deepEqual(data.day().learning, preserved.learning);
  assert.deepEqual(data.day().review, preserved.review);
  assert.deepEqual(data.day().scheduleUpdates, preserved.scheduleUpdates);
  assert.equal(data.day().paused, false);
  assert.equal(
    data.store.snapshot().ledger.days.find((day) => day.id === reviewId)?.phase,
    'finished',
  );
});

test('a new group with no available candidates neither duplicates reserved words nor changes the old group', (t) => {
  const data = fixture(t);
  data.begin();
  data.today('reviewOnly');
  const before = data.store.snapshot();
  assert.throws(() => data.begin(), hasCode('MINI_PLAN_CONFLICT'));
  assert.deepEqual(data.store.snapshot(), before);
  assert.equal(data.context().newCount, 0);
  assert.equal(data.context().canStart, false);
});

test('selection takes the latest recorded schedule even when an older group was finalized later', (t) => {
  const data = fixture(t);
  data.begin([apple]);
  finish(data);
  data.setDate('2026-11-16T04:00:00Z');
  data.begin([apple]);
  finish(data);
  const ledger = data.store.snapshot().ledger;
  const older = ledger.days[0];
  const newer = ledger.days[1];
  const next = newer?.scheduleUpdates[0];
  assert.ok(older && next);
  const late = { ...next, recordedAt: next.recordedAt + 60, dueAt: next.dueAt + 86_400 };
  older.scheduleUpdates.push(late);
  assert.deepEqual(
    miniCandidates(ledger, [apple], next.dueAt).schedules.get(JSON.stringify(['apple', '苹果'])),
    late,
  );
  assert.equal(miniCandidates(ledger, [apple], next.dueAt).due.length, 0);
  late.recordedAt = next.recordedAt;
  assert.deepEqual(
    miniCandidates(ledger, [apple], next.dueAt).schedules.get(JSON.stringify(['apple', '苹果'])),
    next,
  );
});

test('SQLite v1 migration adds planning without changing ledger or revision and persists plans across reopen', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-mini-plans-'));
  const filename = join(directory, 'mini.sqlite');
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const data = fixture(t, filename);
  data.begin([apple]);
  const before = data.store.snapshot();
  data.store.close();
  const db = new DatabaseSync(filename);
  const old: Record<string, unknown> = { ...before };
  delete old.planning;
  db.prepare('UPDATE mini_state SET body=? WHERE id=1').run(JSON.stringify(old));
  db.exec('PRAGMA user_version=1');
  db.close();
  data.reopen();
  assert.equal(data.store.snapshot().revision, before.revision);
  assert.deepEqual(data.store.snapshot().ledger, before.ledger);
  assert.deepEqual(data.store.snapshot().planning, {
    ...defaultMiniPlanning(),
    activeDayId: before.planning.activeDayId,
  });
  data.today('rest');
  const saved = data.store.snapshot();
  data.reopen();
  assert.deepEqual(data.store.snapshot(), saved);
});

test('a failed legacy database validation leaves both its original body and schema version intact', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-mini-plan-migration-'));
  const filename = join(directory, 'mini.sqlite');
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const data = fixture(t, filename);
  data.begin([apple]);
  const snapshot = data.store.snapshot();
  const session = snapshot.ledger.days[0]?.learning;
  assert.ok(session);
  session.queue = [];
  const old: Record<string, unknown> = { ...snapshot };
  delete old.planning;
  const original = JSON.stringify(old);
  data.store.close();
  const db = new DatabaseSync(filename);
  db.prepare('UPDATE mini_state SET body=? WHERE id=1').run(original);
  db.exec('PRAGMA user_version=1');
  db.close();
  assert.throws(() => new MiniStore(filename), hasCode('MINI_STATE_CONFLICT'));
  const untouched = new DatabaseSync(filename);
  assert.equal(
    z
      .object({ body: z.string() })
      .parse(untouched.prepare('SELECT body FROM mini_state WHERE id=1').get()).body,
    original,
  );
  assert.equal(
    z.object({ user_version: z.number() }).parse(untouched.prepare('PRAGMA user_version').get())
      .user_version,
    1,
  );
  untouched.close();
});
