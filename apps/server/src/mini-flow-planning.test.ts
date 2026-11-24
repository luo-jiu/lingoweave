import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  miniCommandSchema,
  miniPlanPreviewSchema,
  type MiniVocabularyImport,
  type MiniWord,
} from '@lingoweave/contracts';
import { z } from 'zod';
import { buildApp } from './app.js';
import { LearningError } from './learning-store.js';
import { MiniVocabularyStore } from './mini-vocabulary-store.js';
import { MiniStore } from './mini-store.js';
import {
  observeMiniFlowScheduling,
  repairMiniReviewPromptSchedules,
  validateMiniFlowScheduling,
} from './mini-flow-scheduler.js';
import {
  currentMiniWindow,
  currentTranslation,
  miniPreparationWords,
  miniWritingWords,
  swiftTime,
} from './mini-study.js';

const timezone = 'Asia/Shanghai';
const words: MiniWord[] = Array.from({ length: 18 }, (_, index) => ({
  spelling: `term${index}`,
  meaning: `词义${index}`,
  phonetic: '',
}));
type Action = z.input<typeof miniCommandSchema>['action'];
async function fixture(t: TestContext, goal: number, size: number) {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-flow-plan-'));
  const filename = join(directory, 'mini.sqlite');
  let date = new Date('2026-11-17T02:00:00Z');
  let store = new MiniStore(filename, { timezone, now: () => date });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  store.importLegacy({
    requestId: randomUUID(),
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
    timezone,
  });
  const act = (action: Action, advanceClock = true) => {
    if (advanceClock) date = new Date(date.getTime() + 1000);
    return store.command(
      miniCommandSchema.parse({
        requestId: randomUUID(),
        expectedRevision: store.snapshot().revision,
        action,
      }),
    );
  };
  const day = () => {
    const snapshot = store.snapshot();
    const result = snapshot.ledger.days.find((item) => item.id === snapshot.planning.activeDayId);
    assert.ok(result);
    return result;
  };
  const context = () => ({ target: 'daily' as const, dayId: day().id });
  const begin = (extra: Partial<Extract<Action, { type: 'begin' }>> = {}) =>
    act({
      type: 'begin',
      target: 'daily',
      deck: words,
      timezone,
      flowVersion: 'sliding-window-v2',
      ...extra,
    });
  const preview = (deck = words) => store.planPreview({ deck, timezone }).planContext;
  const prepare = () => {
    const missing = miniPreparationWords(day()).filter(
      (word) => !day().sentences.some((sentence) => sentence.word.spelling === word.spelling),
    );
    for (let i = 0; i < missing.length; i += 5)
      act({
        ...context(),
        type: 'add_sentences',
        sentences: missing.slice(i, i + 5).map((word) => ({
          word,
          english: `This is ${word.spelling}.`,
          chinese: '这是学习例句。',
        })),
      });
  };
  const visit = () => {
    const result = currentMiniWindow(day())?.visit;
    assert.ok(result);
    return result;
  };
  const memory = (remembered = true) => {
    const current = visit();
    const ctx = {
      ...context(),
      session: 'learning' as const,
      word: current.word,
      visitId: current.id,
    };
    if (current.stage === 0) act({ ...ctx, type: 'window_advance', remembered });
    else {
      act({ ...ctx, type: 'window_choose', remembered });
      act({ ...ctx, type: 'window_advance' });
    }
  };
  const finishMemory = () => {
    for (let i = 0; i < 1000 && currentMiniWindow(day())?.visit; i++) memory();
    assert.ok(day().learning);
  };
  const finishSpelling = (session: 'review' | 'learning' = 'learning') => {
    for (
      let i = 0;
      i < 200 && (session === 'review' ? day().review : day().learning)?.phase === 'spelling';
      i++
    ) {
      const word = (session === 'review' ? day().review : day().learning)?.queue[0];
      assert.ok(word);
      act({
        ...context(),
        session,
        type: 'submit_spelling',
        word,
        answer: word.spelling,
        advanceOnCorrect: false,
      });
      act({ ...context(), session, type: 'advance_spelling', word });
    }
    assert.equal((session === 'review' ? day().review : day().learning)?.phase, 'finished');
  };
  const judgeClear = (word: MiniWord) => {
    const ctx = { ...context(), session: 'review' as const, word };
    act({ ...ctx, type: 'choose_judgment', judgment: 'clear' });
    act({ ...ctx, type: 'advance_judgment' });
  };
  const startWriting = () => {
    const current = day();
    const targets = miniWritingWords(current);
    const prompts = targets.flatMap((word, index) => {
      if (current.writingPrompts?.some((prompt) => prompt.sentence.word.spelling === word.spelling))
        return [];
      const direction = current.directions[index];
      assert.ok(direction);
      return [
        {
          id: randomUUID(),
          sentence: {
            word,
            english: `Please use ${word.spelling} today.`,
            chinese: '请在今天使用它。',
          },
          direction,
          focusIds: [],
        },
      ];
    });
    for (let i = 0; i < prompts.length; i += 10)
      act({ ...context(), type: 'publish_writing', prompts: prompts.slice(i, i + 10) });
    act({ ...context(), type: 'complete_learning' });
  };
  const translate = () => {
    const task = currentTranslation(day());
    assert.ok(task);
    act({
      ...context(),
      type: 'submit_translation',
      taskId: task.id,
      answer: '真实的隔离测试答案',
    });
    act({ ...context(), type: 'advance_translation', taskId: task.id });
  };
  const group = () => {
    finishMemory();
    finishSpelling();
    startWriting();
    while (day().phase === 'translation') translate();
  };
  act({
    type: 'set_long_term_plan',
    target: 'daily',
    plan: {
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      wordLimit: 1,
      newWordLimit: 1,

      dailyNewGoal: goal,
      groupSize: size,
    },
  });
  return {
    filename,
    get store() {
      return store;
    },
    act,
    day,
    context,
    begin,
    preview,
    prepare,
    visit,
    memory,
    finishMemory,
    finishSpelling,
    judgeClear,
    startWriting,
    translate,
    group,
    setDate(value: string) {
      date = new Date(value);
    },
    reopen(oldGroupSize?: number) {
      if (oldGroupSize) {
        // Reconstruct the previous release: every due word had been assigned to this run
        // while the user's saved group size was smaller.
        const state = store.snapshot();
        const original = state.ledger.days.find((day) => day.id === state.planning.activeDayId);
        assert.ok(original?.flow);
        original.flow.groupSize = oldGroupSize;
        state.planning.longTerm.groupSize = oldGroupSize;
        store.close();
        const db = new DatabaseSync(filename);
        db.prepare('UPDATE mini_state SET body=? WHERE id=1').run(JSON.stringify(state));
        db.exec('PRAGMA user_version=10');
        db.close();
      } else store.close();
      store = new MiniStore(filename, { timezone, now: () => date });
    },
  };
}

test('self-reported familiarity releases a window slot once and still requires spelling and confirmed translation', async (t) => {
  const f = await fixture(t, 2, 2);
  f.begin();
  f.prepare();
  const first = f.visit();
  const shortcut = (visit: typeof first) => ({
    ...f.context(),
    type: 'window_familiar' as const,
    session: 'learning' as const,
    word: visit.word,
    visitId: visit.id,
  });
  const request = miniCommandSchema.parse({
    requestId: randomUUID(),
    expectedRevision: f.store.snapshot().revision,
    action: { ...shortcut(first), draft: 'my draft' },
  });
  assert.throws(
    () => f.store.aiCommand(request),
    (error) => error instanceof LearningError && error.code === 'MINI_AI_ACTION_FORBIDDEN',
  );
  const acknowledged = f.store.command(request);
  f.reopen();
  assert.deepEqual(f.store.command(request), acknowledged);
  const second = f.visit();
  assert.deepEqual(second.word, words[5]);
  assert.deepEqual(f.day().flow?.groupWords, [first.word]);
  assert.equal(f.day().flow?.window.members.length, 5);
  const events = f.day().flow?.window.events;
  assert.equal(events?.length, 1);
  assert.deepEqual(
    events?.map(({ word, stage, selfReportedFamiliar, draft }) => ({
      word,
      stage,
      selfReportedFamiliar,
      draft,
    })),
    [{ word: first.word, stage: 0, selfReportedFamiliar: true, draft: 'my draft' }],
  );
  assert.throws(() => f.act(shortcut(first)));
  assert.throws(() => f.act({ ...shortcut(second), word: first.word }));
  assert.deepEqual(f.store.snapshot(), acknowledged);

  f.act(shortcut(second));
  assert.equal(f.day().flow?.window.visit, null);
  assert.deepEqual(f.day().learning?.words, [first.word, second.word]);
  assert.equal(f.day().learning?.spellingAttempts.length, 0);
  assert.throws(() => f.act({ ...f.context(), type: 'complete_learning' }));
  assert.equal(f.preview().completedNewCount, 0);
  assert.equal(f.store.snapshot().scheduling.flow.events.length, 0);
  f.finishSpelling();
  f.startWriting();
  assert.deepEqual(miniWritingWords(f.day()), [first.word, second.word]);
  assert.equal(f.preview().completedNewCount, 0);
  f.translate();
  assert.equal(f.preview().completedNewCount, 1);
  f.translate();
  assert.equal(f.preview().completedNewCount, 2);
  f.setDate('2026-11-17T16:00:00Z');
  assert.equal(f.preview().dueCount, 2);
});

test('v2 correct spelling can advance in the same command without discarding retry evidence', async (t) => {
  const f = await fixture(t, 3, 3);
  f.begin();
  f.prepare();
  f.finishMemory();
  const first = f.day().learning?.queue[0];
  const second = f.day().learning?.queue[1];
  const third = f.day().learning?.queue[2];
  assert.ok(first && second && third);
  const submit = (word: MiniWord, answer: string, automatic = true) =>
    f.act({
      ...f.context(),
      session: 'learning',
      type: 'submit_spelling',
      word,
      answer,
      ...(automatic ? { advanceOnCorrect: false, advanceAfterCorrect: true } : {}),
    });

  submit(first, 'wrong');
  assert.equal(f.day().learning?.spellingState, 'correcting');
  assert.deepEqual(f.day().learning?.queue[0], first);
  submit(first, ` ${first.spelling.toUpperCase()} `);
  const corrected = f.day().learning;
  assert.deepEqual(corrected?.queue, [second, third, first]);
  assert.equal(corrected?.spellingState, 'awaitingFirst');
  assert.equal(corrected?.spellingPromptAt, corrected?.spellingAttempts.at(-1)?.submittedAt);
  assert.deepEqual(
    corrected?.spellingAttempts.map(({ word, kind, correct }) => ({ word, kind, correct })),
    [
      { word: first, kind: 'first', correct: false },
      { word: first, kind: 'correction', correct: true },
    ],
  );
  f.reopen();
  assert.deepEqual(f.day().learning, corrected);

  submit(second, second.spelling, false);
  assert.equal(f.day().learning?.spellingState, 'readyToAdvance');
  assert.deepEqual(f.day().learning?.queue[0], second);
  f.act({ ...f.context(), type: 'advance_spelling', session: 'learning', word: second });
  submit(third, third.spelling);
  assert.deepEqual(f.day().learning?.queue, [first]);
  submit(first, first.spelling);
  assert.equal(f.day().learning?.phase, 'finished');
  assert.equal(f.day().learning?.spellingAttempts.at(-1)?.encounter, 2);
  assert.equal(f.day().phase, 'learning');
});

test('v2 plans separate daily completion goal and group size from old first-view limits across two real SQLite groups', async (t) => {
  const f = await fixture(t, 4, 2);
  f.begin();
  f.prepare();
  assert.equal(f.preview().effective.dailyNewGoal, 4);
  assert.equal(f.preview().effective.groupSize, 2);
  assert.equal(f.day().flow?.groupTarget, 2);
  assert.equal(f.day().learningWords.length, 5);
  assert.equal(f.preview().completedNewCount, 0);
  f.finishMemory();
  assert.equal(f.day().studiedWords.length, 2);
  assert.equal(f.preview().completedNewCount, 0);
  f.finishSpelling();
  f.startWriting();
  assert.equal(f.preview().completedNewCount, 0);
  f.translate();
  assert.equal(f.preview().completedNewCount, 1);
  assert.equal(f.preview().remainingNewCount, 3);
  f.translate();
  assert.equal(f.day().flow?.groupIndex, 2);
  assert.equal(f.preview().completedNewCount, 2);
  f.group();
  assert.equal(f.preview().completedNewCount, 4);
  assert.equal(f.preview().remainingNewCount, 0);
  assert.equal(f.day().paused, true);
  assert.equal(f.day().flow?.window.members.length, 4);
  const saved = f.store.snapshot();
  f.reopen();
  assert.deepEqual(f.store.snapshot(), saved);
});

test('one explicit click extends the preserved window for one group, including a last short group', async (t) => {
  const f = await fixture(t, 1, 2);
  const deck = words.slice(0, 4);
  const date = f.preview(deck).date;
  const extra = () => f.begin({ deck, extraGroupForDate: date });
  const unchanged = f.store.snapshot();
  assert.equal(f.preview([]).todayCompleted, false);
  assert.throws(
    extra,
    (error) => error instanceof LearningError && error.code === 'MINI_PLAN_CONFLICT',
  );
  assert.deepEqual(f.store.snapshot(), unchanged);
  f.begin({ deck });
  f.prepare();
  f.group();
  const dayId = f.day().id;
  const tail = structuredClone(f.day().flow?.window.members);
  assert.equal(tail?.length, 3);
  const preview = f.preview(deck);
  assert.equal(preview.todayCompleted, true);
  assert.equal(preview.newCount, 0);
  assert.equal(preview.canStartExtraGroup, true);
  assert.equal(preview.extraGroupWordCount, 2);
  assert.equal(preview.activeExtraGroupWordCount, undefined);
  assert.equal(
    preview.pendingGroups.some((day) => day.dayId === dayId),
    false,
  );
  const request = miniCommandSchema.parse({
    requestId: randomUUID(),
    expectedRevision: f.store.snapshot().revision,
    action: {
      type: 'begin',
      target: 'daily',
      flowVersion: 'sliding-window-v2',
      deck,
      timezone,
      extraGroupForDate: date,
    },
  });
  const accepted = f.store.command(request);
  assert.deepEqual(f.store.command(request), accepted);
  assert.throws(
    extra,
    (error) => error instanceof LearningError && error.code === 'MINI_PLAN_CONFLICT',
  );
  assert.deepEqual(f.store.snapshot(), accepted);
  assert.equal(f.day().id, dayId);
  assert.deepEqual(f.day().flow?.window.members, tail);
  assert.equal(f.day().flow?.groupTarget, 2);
  assert.equal(f.preview(deck).canContinue, true);
  assert.equal(f.preview(deck).canStartExtraGroup, false);
  f.memory();
  const visit = f.visit();
  f.reopen();
  f.begin({ deck });
  assert.deepEqual(f.visit(), visit);
  f.finishMemory();
  f.finishSpelling();
  f.startWriting();
  f.translate();
  assert.equal(f.preview(deck).completedNewCount, 2);
  assert.equal(f.preview(deck).activeExtraGroupWordCount, 2);
  f.translate();
  assert.equal(f.day().flow?.completed.length, 3);
  assert.equal(f.day().paused, true);
  assert.equal(f.preview(deck).extraGroupWordCount, 1);
  extra();
  assert.equal(f.day().flow?.groupTarget, 1);
  assert.equal(f.preview(deck).activeExtraGroupWordCount, 1);
  f.group();
  assert.equal(f.day().phase, 'finished');
  assert.deepEqual(
    f.day().flow?.groups.map((group) => group.words.length),
    [1, 2, 1],
  );
  assert.equal(f.preview(deck).completedNewCount, 4);
  assert.equal(f.preview(deck).activeExtraGroupWordCount, undefined);
  assert.equal(f.preview(deck).todayCompleted, true);
  assert.equal(f.preview(deck).canStartExtraGroup, false);
  assert.equal(f.preview(deck).effective.dailyNewGoal, 1);
  assert.deepEqual(f.store.snapshot().planning.longTerm, unchanged.planning.longTerm);
  assert.deepEqual(f.store.snapshot().planning.dailyOverrides, []);
  f.setDate('2026-11-18T02:00:00Z');
  assert.equal(f.preview(deck).todayCompleted, false);
  assert.equal(f.preview(deck).remainingNewCount, 1);
  assert.equal(f.preview(deck).dueCount, 4);
  assert.throws(
    extra,
    (error) => error instanceof LearningError && error.code === 'MINI_PLAN_CONFLICT',
  );
});

test('an extra group extends its existing material pool and a new day starts a fresh window on the regular allowance', async (t) => {
  const f = await fixture(t, 1, 3);
  f.begin();
  f.prepare();
  f.group();
  const regular = f.day();
  const pool = miniPreparationWords(regular);
  f.begin({ extraGroupForDate: f.preview().date });
  assert.ok(miniPreparationWords(f.day()).length > pool.length);
  assert.deepEqual(miniPreparationWords(f.day()).slice(0, pool.length), pool);
  assert.deepEqual(f.day().sentences, regular.sentences);
  f.prepare();
  f.memory();
  const saved = f.day();
  f.setDate('2026-11-18T02:00:00Z');
  assert.equal(f.preview().dueCount, 1);
  assert.equal(f.preview().canStartExtraGroup, false);
  f.begin();
  assert.equal(f.day().phase, 'review');
  const word = f.day().review?.queue[0];
  assert.ok(word);
  f.act({ ...f.context(), session: 'review', word, type: 'choose_judgment', judgment: 'clear' });
  f.act({ ...f.context(), session: 'review', word, type: 'advance_judgment', markWrong: false });
  f.finishSpelling('review');
  f.act({ ...f.context(), type: 'complete_review' });
  assert.notEqual(f.day().id, saved.id);
  assert.deepEqual(
    f.store.snapshot().ledger.days.find((day) => day.id === saved.id)?.flow,
    saved.flow,
  );
  assert.equal(f.day().flow?.window.sequence, 0);
  assert.ok(f.day().flow?.window.members.every((item) => item.stage === 0));
  f.prepare();
  assert.equal(f.day().flow?.groupTarget, 1);
  assert.equal(f.day().flow?.extraGroupTarget, undefined);
  f.group();
  assert.equal(f.preview().todayCompleted, true);
  assert.equal(f.preview().completedNewCount, 1);
});

test('extra practice can start a fresh run from an expanded deck after the old run is finished', async (t) => {
  const f = await fixture(t, 1, 2);
  const deck = words.slice(0, 4);
  f.begin({ deck: deck.slice(0, 1) });
  f.prepare();
  f.group();
  assert.equal(f.day().phase, 'finished');
  const old = f.day().id;
  assert.equal(f.preview(deck).canStartExtraGroup, true);
  f.begin({ deck, extraGroupForDate: f.preview(deck).date });
  assert.notEqual(f.day().id, old);
  assert.equal(f.day().flow?.groupTarget, 2);
  f.prepare();
  f.group();
  assert.equal(f.preview(deck).completedNewCount, 3);
  assert.equal(f.preview(deck).extraGroupWordCount, 1);
});

test('a review-only day with no due words differs from one whose due review finished today', async (t) => {
  const f = await fixture(t, 1, 1);
  const deck = words.slice(0, 1);
  const reviewOnly = () =>
    f.act({
      type: 'set_today_plan',
      target: 'daily',
      date: f.preview(deck).date,
      timezone,
      mode: 'reviewOnly',
      wordLimit: 1,
      newWordLimit: 0,
    });
  reviewOnly();
  assert.equal(f.preview(deck).todayCompleted, false);
  f.act({ type: 'clear_today_plan', target: 'daily', date: f.preview(deck).date, timezone });
  f.begin({ deck });
  f.prepare();
  f.group();
  f.setDate('2026-11-18T02:00:00Z');
  reviewOnly();
  f.begin({ deck });
  const word = f.day().review?.queue[0];
  assert.ok(word);
  f.act({ ...f.context(), session: 'review', word, type: 'choose_judgment', judgment: 'clear' });
  f.act({ ...f.context(), session: 'review', word, type: 'advance_judgment', markWrong: false });
  f.finishSpelling('review');
  assert.equal(f.preview(deck).todayCompleted, false);
  f.act({ ...f.context(), type: 'complete_review' });
  assert.equal(f.preview(deck).todayCompleted, true);
  assert.equal(f.preview(deck).canStartExtraGroup, false);
});

test('v2 all due words precede new learning, newGroup cannot bypass pending review, and yesterday’s tail restarts from full cards', async (t) => {
  const f = await fixture(t, 7, 7);
  f.begin();
  f.prepare();
  f.group();
  const oldId = f.day().id;
  const tail = structuredClone(f.day().flow?.window.members);
  assert.equal(tail?.length, 4);
  f.setDate('2026-11-18T02:00:00Z');
  f.reopen();
  assert.equal(f.preview().completedNewCount, 0);
  assert.equal(f.preview().dueCount, 7);
  assert.equal(f.preview().pendingGroups.length, 0);
  assert.throws(
    () => f.begin({ dayId: oldId }),
    (error) => error instanceof LearningError && error.code === 'MINI_PLAN_CONFLICT',
  );
  f.begin();
  assert.equal(f.day().phase, 'review');
  assert.equal(f.day().reviewWords.length, 7);
  assert.equal(f.day().learningWords.length, 0);
  const reviewId = f.day().id;
  const before = f.store.snapshot();
  let refused = false;
  try {
    f.begin({ newGroup: true });
  } catch (error) {
    assert.ok(error instanceof LearningError && error.code === 'MINI_PLAN_CONFLICT');
    refused = true;
    assert.deepEqual(f.store.snapshot(), before);
  }
  if (!refused) {
    assert.equal(f.day().phase, 'review');
    assert.equal(f.day().id, reviewId);
  }
  assert.throws(
    () => f.act({ target: 'daily', dayId: oldId, type: 'pause', paused: false }),
    (error) => error instanceof LearningError,
  );
  for (let i = 0; i < 7; i++) {
    const word = f.day().review?.queue[0];
    assert.ok(word);
    f.act({ ...f.context(), type: 'choose_judgment', session: 'review', word, judgment: 'clear' });
    f.act({ ...f.context(), type: 'advance_judgment', session: 'review', word, markWrong: false });
  }
  assert.equal(f.day().phase, 'review');
  assert.equal(f.day().review?.phase, 'spelling');
  f.finishSpelling('review');
  f.act({ ...f.context(), type: 'complete_review' });
  assert.equal(f.day().phase, 'learning');
  f.reopen();
  const plan = f.preview();
  assert.equal(plan.pendingDayId, reviewId);
  assert.equal(plan.canContinue, true);
  assert.equal(plan.hasDueReviews, false);
  assert.equal(plan.remainingNewCount, 7);
  const previous = f.store.snapshot().ledger.days.find((item) => item.id === oldId);
  assert.ok(previous?.archivedAt);
  assert.deepEqual(previous.flow?.window.members, tail);
  assert.equal(f.day().flow?.targetDate, plan.date);
  assert.equal(f.day().flow?.groupTarget, 7);
  assert.equal(f.visit().stage, 0);
  assert.equal(f.day().flow?.window.events.length, 0);
  assert.equal(f.preview().completedNewCount, 0);
});

for (const mode of ['normal', 'reviewOnly', 'rest'] as const) {
  test(`due reviews settle and continue by group, including an incomplete last group (${mode})`, async (t) => {
    const reviewOnly = mode === 'reviewOnly';
    const f = await fixture(t, 7, 7);
    f.begin();
    f.prepare();
    f.group();
    f.setDate('2026-11-18T02:00:00Z');
    f.act({
      type: 'set_today_plan',
      target: 'daily',
      date: f.preview().date,
      timezone,
      mode,
      wordLimit: 7,
      newWordLimit: reviewOnly ? 0 : 2,
      groupSize: 3,
      dailyNewGoal: reviewOnly ? 0 : 2,
    });
    f.begin({ deck: words.slice(10), overrideRest: mode === 'rest' });
    const mixedId = f.day().id;
    const studied = new Set<string>();
    for (const size of [3, 3, 1]) {
      const group = f.day();
      assert.equal(group.phase, 'review');
      assert.equal(group.paused, false);
      assert.equal(group.reviewWords.length, size);
      assert.equal(f.preview().dueCount, 7 - studied.size);
      assert.equal(f.preview().hasDueReviews, true);
      for (const word of group.reviewWords) {
        assert.equal(studied.has(word.spelling), false);
        studied.add(word.spelling);
        f.act({
          ...f.context(),
          session: 'review',
          type: 'choose_judgment',
          word,
          judgment: 'clear',
        });
        f.act({ ...f.context(), session: 'review', type: 'advance_judgment', word });
      }
      assert.equal(f.day().review?.queue.length, size);
      f.finishSpelling('review');
      const command = miniCommandSchema.parse({
        requestId: randomUUID(),
        expectedRevision: f.store.snapshot().revision,
        action: { ...f.context(), type: 'complete_review' },
      });
      const after = f.store.command(command);
      assert.deepEqual(f.store.command(command), after);
      f.reopen();
      assert.deepEqual(f.store.snapshot(), after);
      const reviews = after.scheduling.flow.events.filter((e) => e.kind === 'review');
      assert.deepEqual(new Set(reviews.map((e) => e.word.spelling)), studied);
      assert.equal(reviews.length, studied.size * 2); // One judgment and one spelling result per word.
      if (studied.size < 7) {
        assert.equal(f.day().phase, 'review');
        assert.equal(after.ledger.days.find((d) => d.id === mixedId)?.learningWords.length, 0);
      }
    }
    assert.equal(f.preview().dueCount, 0);
    if (reviewOnly) {
      assert.equal(f.day().phase, 'finished');
      assert.equal(f.preview().todayCompleted, true);
    } else {
      assert.equal(f.day().id, mixedId);
      assert.equal(f.day().phase, 'learning');
      assert.ok(f.visit());
      assert.ok(words.slice(10).some((word) => word.spelling === f.visit().word.spelling));
    }
  });
}
const rejectsPlanAction = (error: unknown) =>
  error instanceof LearningError && error.code === 'MINI_PLAN_CONFLICT';

async function smallReviewWithSixDue(t: TestContext) {
  const f = await fixture(t, 6, 6);
  f.begin({ deck: words.slice(0, 6) });
  f.prepare();
  f.group();
  f.act({
    type: 'set_long_term_plan',
    target: 'daily',
    plan: { ...f.store.snapshot().planning.longTerm, groupSize: 2 },
  });
  f.setDate('2026-11-18T02:00:00Z');
  f.begin({ intent: 'review' });
  assert.equal(f.day().reviewWords.length, 2);
  assert.equal(f.preview().dueCount, 6);
  return f;
}

test('saving a larger group immediately extends an opened review before its first answer', async (t) => {
  const f = await smallReviewWithSixDue(t);
  const original = f.day();
  const first = original.review?.queue[0];
  assert.ok(first);
  f.act({ ...f.context(), word: first, session: 'review', type: 'record_card_view' });
  const recorded = f.store.snapshot();
  f.act({
    type: 'set_long_term_plan',
    target: 'daily',
    plan: { ...recorded.planning.longTerm, groupSize: 4 },
  });
  const resized = f.day();
  assert.equal(resized.id, original.id);
  assert.equal(resized.reviewWords.length, 4);
  assert.deepEqual(resized.reviewWords.slice(0, 2), original.reviewWords);
  assert.deepEqual(resized.reviewSteps.slice(0, 2), original.reviewSteps);
  assert.equal(resized.reviewSteps.length, 4);
  assert.deepEqual(resized.review?.queue, resized.reviewWords);
  assert.deepEqual(resized.review?.words, resized.reviewWords);
  assert.deepEqual(resized.review?.judgmentEvents, []);
  assert.ok(
    resized.reviewWords.every((word) =>
      resized.sentences.some((sentence) => word.spelling === sentence.word.spelling),
    ),
  );
  assert.deepEqual(f.store.snapshot().teaching.exposures, recorded.teaching.exposures);
  assert.deepEqual(f.store.snapshot().scheduling.flow, recorded.scheduling.flow);
  assert.equal(f.preview().dueCount, 6);
});

test('today’s smaller group releases surplus words for the next group and takes precedence over the weekly plan', async (t) => {
  const f = await smallReviewWithSixDue(t);
  const original = f.day();
  const date = f.preview().date;
  f.act({
    type: 'set_today_plan',
    target: 'daily',
    date,
    timezone,
    mode: 'normal',
    wordLimit: 1,
    newWordLimit: 1,
    groupSize: 1,
  });
  assert.equal(f.day().id, original.id);
  assert.deepEqual(f.day().reviewWords, original.reviewWords.slice(0, 1));
  assert.deepEqual(f.day().review?.queue, f.day().reviewWords);
  assert.equal(f.preview().dueCount, 6);
  f.act({
    type: 'set_long_term_plan',
    target: 'daily',
    plan: { ...f.store.snapshot().planning.longTerm, groupSize: 10 },
  });
  assert.equal(f.preview().effective.groupSize, 1);
  assert.deepEqual(f.day().reviewWords, original.reviewWords.slice(0, 1));
  const first = f.day().review?.queue[0];
  assert.ok(first);
  f.judgeClear(first);
  f.finishSpelling('review');
  f.act({ ...f.context(), type: 'complete_review' });
  assert.notEqual(f.day().id, original.id);
  assert.deepEqual(f.day().reviewWords, original.reviewWords.slice(1));
  assert.equal(f.preview().dueCount, 5);
  f.act({ type: 'clear_today_plan', target: 'daily', date, timezone });
  assert.equal(f.preview().effective.groupSize, 10);
  assert.equal(f.day().reviewWords.length, 5);
  assert.deepEqual(f.day().reviewWords.slice(0, 1), original.reviewWords.slice(1));
  assert.equal(f.preview().dueCount, 5);
});

test('reentering an unanswered review adopts a larger plan saved by a previous release', async (t) => {
  const f = await smallReviewWithSixDue(t);
  const original = f.day();
  // Persist the mismatch left by the older plan save path, which updated settings but not review targets.
  const previous = f.store.snapshot();
  previous.planning.longTerm.groupSize = 4;
  const db = new DatabaseSync(f.filename);
  db.prepare('UPDATE mini_state SET body=? WHERE id=1').run(JSON.stringify(previous));
  db.close();
  f.reopen();
  assert.equal(f.preview().effective.groupSize, 4);
  assert.equal(f.day().reviewWords.length, 2);
  f.begin({ intent: 'review' });
  assert.equal(f.day().id, original.id);
  assert.equal(f.day().reviewWords.length, 4);
  assert.deepEqual(f.day().reviewWords.slice(0, 2), original.reviewWords);
  assert.equal(f.preview().dueCount, 6);
  const repaired = f.store.snapshot();
  f.reopen();
  assert.deepEqual(f.store.snapshot(), repaired);
});

test('review resizing keeps confirmed judgments and the current selected answer', async (t) => {
  const f = await smallReviewWithSixDue(t);
  const original = f.day();
  const completed = original.review?.queue[0];
  assert.ok(completed);
  f.judgeClear(completed);
  const pending = f.day().review?.queue[0];
  assert.ok(pending);
  const answer = { ...f.context(), word: pending, session: 'review' as const };
  f.act({ ...answer, type: 'choose_judgment', judgment: 'clear' });
  const events = f.day().review?.judgmentEvents;
  f.act({
    type: 'set_long_term_plan',
    target: 'daily',
    plan: { ...f.store.snapshot().planning.longTerm, groupSize: 5 },
  });
  const expanded = f.day();
  assert.equal(expanded.id, original.id);
  assert.equal(expanded.reviewWords.length, 5);
  assert.deepEqual(expanded.reviewWords.slice(0, 2), original.reviewWords);
  assert.deepEqual(expanded.review?.queue, expanded.reviewWords.slice(1));
  assert.deepEqual(expanded.review?.judgmentEvents, events);
  assert.equal(f.preview().dueCount, 6);
  f.act({
    type: 'set_long_term_plan',
    target: 'daily',
    plan: { ...f.store.snapshot().planning.longTerm, groupSize: 3 },
  });
  f.reopen();
  assert.equal(f.day().id, original.id);
  assert.deepEqual(f.day().reviewWords, expanded.reviewWords.slice(0, 3));
  assert.deepEqual(f.day().review?.queue, expanded.reviewWords.slice(1, 3));
  assert.deepEqual(f.day().review?.judgmentEvents, events);
  assert.equal(f.preview().dueCount, 6);
  f.act({ ...answer, type: 'advance_judgment' });
  const next = f.day().review?.queue[0];
  assert.ok(next);
  f.judgeClear(next);
  f.finishSpelling('review');
  f.act({ ...f.context(), type: 'complete_review' });
  assert.notEqual(f.day().id, original.id);
  assert.equal(f.day().reviewWords.length, 3);
  for (const deferred of expanded.reviewWords.slice(3)) {
    assert.ok(f.day().reviewWords.some((word) => word.spelling === deferred.spelling));
  }
  assert.equal(f.preview().dueCount, 3);
});

test('lowering the review target below completed judgments still retains those answers', async (t) => {
  const f = await smallReviewWithSixDue(t);
  const setSize = (groupSize: number) =>
    f.act({
      type: 'set_long_term_plan',
      target: 'daily',
      plan: { ...f.store.snapshot().planning.longTerm, groupSize },
    });
  setSize(5);
  const original = f.day();
  assert.equal(original.reviewWords.length, 5);
  const retained = original.reviewWords.slice(0, 3);
  const deferred = original.reviewWords.slice(3);
  for (const word of retained) f.judgeClear(word);
  const events = f.day().review?.judgmentEvents;
  setSize(2);
  assert.equal(f.day().id, original.id);
  assert.deepEqual(f.day().reviewWords, retained);
  assert.equal(f.day().review?.phase, 'spelling');
  assert.deepEqual(new Set(f.day().review?.queue), new Set(retained));
  assert.deepEqual(f.day().review?.judgmentEvents, events);
  assert.equal(f.preview().dueCount, 6);
  f.reopen();
  assert.deepEqual(f.day().review?.judgmentEvents, events);
  f.finishSpelling('review');
  f.act({ ...f.context(), type: 'complete_review' });
  assert.notEqual(f.day().id, original.id);
  assert.deepEqual(f.day().reviewWords, deferred);
  assert.equal(f.preview().dueCount, 3);
});

test('expanding a review puts new first judgments before the queued fuzzy retry', async (t) => {
  const f = await smallReviewWithSixDue(t);
  const original = f.day();
  const [fuzzy, next] = original.reviewWords;
  assert.ok(fuzzy && next);
  const answer = { ...f.context(), word: fuzzy, session: 'review' as const };
  f.act({ ...answer, type: 'choose_judgment', judgment: 'fuzzy' });
  f.act({ ...answer, type: 'advance_judgment' });
  const events = f.day().review?.judgmentEvents;
  assert.deepEqual(f.day().review?.queue, [next, fuzzy]);
  f.act({
    type: 'set_long_term_plan',
    target: 'daily',
    plan: { ...f.store.snapshot().planning.longTerm, groupSize: 4 },
  });
  const expanded = f.day();
  assert.equal(expanded.id, original.id);
  assert.equal(expanded.reviewWords.length, 4);
  assert.deepEqual(expanded.reviewWords.slice(0, 2), original.reviewWords);
  assert.deepEqual(expanded.review?.queue, [...expanded.reviewWords.slice(1), fuzzy]);
  assert.deepEqual(expanded.review?.judgmentEvents, events);
  f.reopen();
  assert.deepEqual(f.day().review, expanded.review);
  for (const word of expanded.reviewWords.slice(1)) f.judgeClear(word);
  assert.deepEqual(f.day().review?.queue, [fuzzy]);
  f.judgeClear(fuzzy);
  f.finishSpelling('review');
});

test('a recorded fuzzy retry takes precedence over applying the larger group immediately', async (t) => {
  const f = await smallReviewWithSixDue(t);
  const original = f.day();
  const [fuzzy, next] = original.reviewWords;
  assert.ok(fuzzy && next);
  const answer = { ...f.context(), word: fuzzy, session: 'review' as const };
  f.act({ ...answer, type: 'choose_judgment', judgment: 'fuzzy' });
  f.act({ ...answer, type: 'advance_judgment' });
  f.judgeClear(next);
  f.act({ ...answer, type: 'choose_judgment', judgment: 'fuzzy' });
  const retry = f.day().review;
  f.act({
    type: 'set_long_term_plan',
    target: 'daily',
    plan: { ...f.store.snapshot().planning.longTerm, groupSize: 4 },
  });
  assert.equal(f.day().id, original.id);
  assert.deepEqual(f.day().reviewWords, original.reviewWords);
  assert.deepEqual(f.day().review, retry);
  f.act({ ...answer, type: 'advance_judgment' });
  f.judgeClear(fuzzy);
  f.finishSpelling('review');
  f.act({ ...f.context(), type: 'complete_review' });
  assert.notEqual(f.day().id, original.id);
  assert.equal(f.day().reviewWords.length, 4);
});

test('a scheduled rest day offers all due reviews, resumes the same judgment queue and ends without new words', async (t) => {
  const f = await fixture(t, 3, 3);
  const weekly = { ...f.store.snapshot().planning.longTerm, weekdays: [2], groupSize: 2 };
  f.begin({ intent: 'learn', deck: words.slice(0, 3) });
  f.prepare();
  f.group();
  f.act({ type: 'set_long_term_plan', target: 'daily', plan: weekly });
  f.setDate('2026-11-18T02:00:00Z');
  f.act({ type: 'set_session_plan', target: 'daily', wordLimit: 4, newWordLimit: 2 });
  const initial = f.preview();
  assert.equal(initial.effective.mode, 'rest');
  assert.equal(initial.dueCount, 3);
  assert.equal(initial.canStartReview, true);
  assert.equal(initial.canStartLearning, false);
  const snapshot = f.store.snapshot();
  assert.throws(() => f.begin({ intent: 'learn' }), rejectsPlanAction);
  assert.deepEqual(f.store.snapshot(), snapshot);

  f.begin({ intent: 'review' });
  const first = f.day().reviewWords[0];
  assert.ok(first);
  f.judgeClear(first);
  const groupId = f.day().id;
  const review = f.day().review;
  f.act({ ...f.context(), type: 'pause', paused: true });
  f.reopen();
  assert.equal(f.preview().canStartReview, true);
  f.begin({ intent: 'review' });
  assert.equal(f.day().id, groupId);
  assert.deepEqual(f.day().review, review);
  const remaining = f.day().reviewWords.slice(1);
  assert.equal(remaining.length, 1);
  for (const word of remaining) f.judgeClear(word);
  f.finishSpelling('review');
  f.act({ ...f.context(), type: 'complete_review' });
  assert.equal(f.preview().dueCount, 1);
  assert.equal(f.day().phase, 'review');
  for (const word of f.day().reviewWords) f.judgeClear(word);
  f.finishSpelling('review');
  f.act({ ...f.context(), type: 'complete_review' });
  assert.equal(f.day().phase, 'finished');
  assert.deepEqual(miniPreparationWords(f.day()), []);
  const done = f.preview();
  assert.equal(done.canStartReview, false);
  assert.equal(done.canStartLearning, false);
  assert.equal(done.canStartExtraGroup, true);
  assert.equal(done.completedNewCount, 0);
  assert.deepEqual(f.store.snapshot().planning.longTerm, weekly);
  assert.deepEqual(f.store.snapshot().planning.dailyOverrides, []);
  assert.deepEqual(
    f.store.snapshot().planning.nextSessionOverride,
    snapshot.planning.nextSessionOverride,
  );
  const after = f.store.snapshot();
  assert.throws(() => f.begin({ intent: 'review' }), rejectsPlanAction);
  assert.deepEqual(f.store.snapshot(), after);
});

test('a rest-day extra click grants one group, survives a same-day resume and expires at local midnight', async (t) => {
  const f = await fixture(t, 8, 2);
  const weekly = { ...f.store.snapshot().planning.longTerm, weekdays: [1] };
  f.act({ type: 'set_long_term_plan', target: 'daily', plan: weekly });
  const { date, extraGroupWordCount, canStartReview } = f.preview();
  assert.equal(canStartReview, false);
  assert.equal(extraGroupWordCount, 2);
  const initial = f.store.snapshot();
  assert.throws(() => f.begin({ intent: 'review' }), rejectsPlanAction);
  assert.throws(() => f.begin({ intent: 'learn' }), rejectsPlanAction);
  assert.deepEqual(f.store.snapshot(), initial);
  const request = miniCommandSchema.parse({
    requestId: randomUUID(),
    expectedRevision: initial.revision,
    action: {
      type: 'begin',
      target: 'daily',
      deck: words,
      timezone,
      flowVersion: 'sliding-window-v2',
      intent: 'learn',
      extraGroupForDate: date,
    },
  });
  const started = f.store.command(request);
  assert.deepEqual(f.store.command(request), started);
  assert.equal(f.day().flow?.groupTarget, 2);
  assert.equal(f.preview().canStartExtraGroup, false);
  f.prepare();
  f.memory();
  const visit = f.visit();
  const dayId = f.day().id;
  f.act({ ...f.context(), type: 'pause', paused: true });
  f.reopen();
  const paused = f.store.snapshot();
  assert.equal(f.preview().canStartLearning, true);
  assert.throws(() => f.begin({ intent: 'review' }), rejectsPlanAction);
  assert.deepEqual(f.store.snapshot(), paused);
  f.begin({ intent: 'learn' });
  assert.equal(f.day().id, dayId);
  assert.deepEqual(f.visit(), visit);
  f.group();
  assert.equal(f.preview().completedNewCount, 2);
  assert.equal(f.preview().canStartLearning, false);
  assert.equal(f.preview().canStartExtraGroup, true);
  assert.throws(() => f.begin({ intent: 'learn' }), rejectsPlanAction);
  f.begin({ intent: 'learn', extraGroupForDate: date });
  assert.equal(f.day().flow?.groupTarget, 2);
  f.prepare();
  f.memory();
  f.setDate('2026-11-17T16:00:00Z');
  f.reopen();
  const tomorrow = f.preview();
  assert.equal(tomorrow.date, '2026-11-18');
  assert.equal(tomorrow.canStartLearning, false);
  assert.equal(tomorrow.activeExtraGroupWordCount, undefined);
  assert.equal(tomorrow.canStartReview, true);
  assert.equal(tomorrow.dueCount, 2);
  assert.throws(() => f.begin({ intent: 'learn', extraGroupForDate: date }), rejectsPlanAction);
  assert.throws(() => f.begin({ intent: 'learn' }), rejectsPlanAction);
  f.begin({ intent: 'review' });
  assert.notEqual(f.day().id, dayId);
  assert.deepEqual(f.store.snapshot().planning.longTerm, weekly);
  assert.deepEqual(f.store.snapshot().planning.dailyOverrides, []);
});

test('explicit rest-day extra study finishes outstanding reviews before its single new group', async (t) => {
  const f = await fixture(t, 6, 2);
  f.begin({ deck: words.slice(0, 2) });
  f.prepare();
  f.group();
  f.act({
    target: 'daily',
    type: 'set_long_term_plan',
    plan: { ...f.store.snapshot().planning.longTerm, weekdays: [2], groupSize: 1 },
  });
  f.setDate('2026-11-18T02:00:00Z');
  const { date } = f.preview();
  f.act({
    target: 'daily',
    type: 'set_today_plan',
    date,
    timezone,
    mode: 'reviewOnly',
    wordLimit: 1,
    newWordLimit: 0,
  });
  assert.equal(f.preview().canStartReview, true);
  assert.equal(f.preview().canStartLearning, false);
  assert.equal(f.preview().canStartExtraGroup, false);
  assert.throws(() => f.begin({ intent: 'learn', extraGroupForDate: date }), rejectsPlanAction);
  f.act({ target: 'daily', type: 'clear_today_plan', date, timezone });
  assert.equal(f.preview().canStartExtraGroup, true);
  f.begin({ intent: 'learn', extraGroupForDate: date });
  assert.equal(f.day().phase, 'review');
  for (const count of [2, 1]) {
    assert.equal(f.preview().dueCount, count);
    assert.equal(f.preview().activeExtraGroupWordCount, 1);
    assert.equal(f.preview().extraGroupWordCount, 0);
    assert.equal(f.day().reviewWords.length, 1);
    const word = f.day().reviewWords[0];
    assert.ok(word);
    f.judgeClear(word);
    f.finishSpelling('review');
    f.act({ ...f.context(), type: 'complete_review' });
  }
  assert.equal(f.preview().dueCount, 0);
  assert.equal(f.day().phase, 'learning');
  assert.equal(f.day().flow?.groupTarget, 1);
  f.prepare();
  f.group();
  assert.equal(f.preview().completedNewCount, 1);
  assert.ok(f.day().paused || f.day().phase === 'finished');
  assert.equal(f.preview().canStartLearning, false);
  assert.equal(f.preview().canStartExtraGroup, true);
});

for (const finalIntent of ['review', 'learn'] as const) {
  test(`switching home entry during review preserves the current judgment and honors the final ${finalIntent} selection`, async (t) => {
    const f = await fixture(t, 2, 2);
    f.begin();
    f.prepare();
    f.group();
    f.setDate('2026-11-18T02:00:00Z');
    assert.equal(f.preview().canStartLearning, true);
    f.begin({ intent: finalIntent === 'review' ? 'learn' : 'review' });
    const first = f.day().reviewWords[0];
    const second = f.day().reviewWords[1];
    assert.ok(first && second);
    f.judgeClear(first);
    const original = f.day().review;
    f.begin({ intent: finalIntent });
    f.reopen();
    assert.deepEqual(f.day().review, original);
    f.judgeClear(second);
    f.finishSpelling('review');
    f.act({ ...f.context(), type: 'complete_review' });
    assert.equal(f.preview().dueCount, 0);
    assert.equal(f.preview().completedNewCount, 0);
    if (finalIntent === 'learn') {
      assert.equal(f.day().phase, 'learning');
      assert.equal(f.day().paused, false);
    } else {
      assert.ok(f.day().paused || f.day().phase === 'finished');
      assert.equal(f.preview().canStartLearning, true);
      f.begin({ intent: 'learn' });
      assert.equal(f.day().phase, 'learning');
    }
    assert.equal(f.day().flow?.groupTarget, 2);
    assert.ok(f.visit());
  });
}

test('fourth-day review includes new completions and genuinely helped words without returning every cohort', async (t) => {
  const f = await fixture(t, 2, 2);
  const cohorts: string[][] = [];
  for (const dayOfMonth of [17, 18, 19]) {
    f.setDate(`2026-11-${dayOfMonth}T08:00:00Z`);
    f.begin();
    while (f.day().phase === 'review') {
      for (const word of f.day().reviewWords) {
        const ctx = { ...f.context(), word, session: 'review' as const };
        f.act({ ...ctx, type: 'record_card_view' });
        f.act({
          ...ctx,
          type: 'record_exposure',
          source: 'audio',
          kind: 'potentialHelp',
          audioKind: 'word',
          focusIds: [],
        });
        if (word.spelling === cohorts[1]?.[0]) {
          f.act({
            ...ctx,
            type: 'record_exposure',
            source: 'chat',
            kind: 'potentialHelp',
            focusIds: [],
          });
        }
        f.act({ ...ctx, type: 'choose_judgment', judgment: 'clear' });
        f.act({ ...ctx, type: 'advance_judgment' });
      }
      f.finishSpelling('review');
      f.act({ ...f.context(), type: 'complete_review' });
    }
    f.prepare();
    f.group();
    const completed = f.day().flow?.completed.map((item) => item.word.spelling);
    assert.equal(completed?.length, 2);
    cohorts.push(completed ?? []);
  }
  f.setDate('2026-11-20T12:00:00Z');
  f.reopen();
  const snapshot = f.store.snapshot();
  const due = snapshot.scheduling.flow.cards
    .filter((card) => card.dueAt <= swiftTime(new Date('2026-11-20T12:00:00Z')))
    .map((card) => card.word.spelling);
  assert.equal(snapshot.scheduling.flow.cards.length, 6);
  assert.equal(f.preview().dueCount, due.length);
  const [helped, unaided] = cohorts[1] ?? [];
  assert.ok(helped && unaided);
  assert.ok(due.includes(helped));
  assert.ok(!due.includes(unaided));
  assert.ok(
    cohorts[2]?.every((word) => due.includes(word)),
    'new words get their first review the next day',
  );
});

test('choosing to rest again between spelling and review completion revokes the temporary session', async (t) => {
  const f = await fixture(t, 3, 3);
  f.begin();
  f.prepare();
  f.group();
  f.setDate('2026-11-18T02:00:00Z');
  const rest = () =>
    f.act({
      type: 'set_today_plan',
      target: 'daily',
      date: f.preview().date,
      timezone,
      mode: 'rest',
      wordLimit: 3,
      newWordLimit: 2,
      dailyNewGoal: 2,
      groupSize: 1,
    });
  rest();
  f.begin({ overrideRest: true });
  const mixed = f.day().id;
  for (let i = 0; i < 2; i++) {
    const word = f.day().review?.queue[0];
    assert.ok(word);
    f.act({ ...f.context(), type: 'choose_judgment', session: 'review', word, judgment: 'clear' });
    f.act({ ...f.context(), type: 'advance_judgment', session: 'review', word });
    f.finishSpelling('review');
    if (i === 1) rest();
    f.act({ ...f.context(), type: 'complete_review' });
  }
  assert.equal(f.preview().dueCount, 1);
  assert.equal(f.preview().canContinue, false);
  assert.equal(
    f.store.snapshot().planning.sessions.some((session) => session.endedAt === undefined),
    false,
  );
  assert.equal(
    f.store.snapshot().ledger.days.find((day) => day.id === mixed)?.learningWords.length,
    0,
  );
});
test('an old full-day review is split on reopen while pending judgments, spelling evidence and prepared material keep their identity', async (t) => {
  const f = await fixture(t, 7, 7);
  f.begin();
  f.prepare();
  f.group();
  f.setDate('2026-11-18T02:00:00Z');
  f.begin();
  const original = f.day();
  const [first, second] = original.reviewWords;
  assert.ok(first && second);
  f.act({
    ...f.context(),
    session: 'review',
    type: 'choose_judgment',
    word: first,
    judgment: 'fuzzy',
  });
  f.act({ ...f.context(), session: 'review', type: 'advance_judgment', word: first });
  f.act({
    ...f.context(),
    session: 'review',
    type: 'choose_judgment',
    word: second,
    judgment: 'clear',
  });
  const pending = f.day().review?.judgmentEvents;
  f.reopen(3);
  assert.equal(f.day().id, original.id);
  assert.equal(f.day().reviewWords.length, 3);
  assert.deepEqual(f.day().review?.queue[0], second);
  assert.deepEqual(f.day().review?.judgmentEvents, pending);
  const groups = f.store
    .snapshot()
    .ledger.days.filter((day) => day.flow?.targetDate === '2026-11-18');
  assert.deepEqual(
    groups.map((g) => g.reviewWords.length),
    [3, 3, 1],
  );
  assert.deepEqual(
    groups.flatMap((g) => g.reviewWords),
    original.reviewWords,
  );
  assert.deepEqual(
    groups.flatMap((g) => g.reviewSteps),
    original.reviewSteps,
  );
  const material = (days: typeof groups) =>
    days.flatMap((g) => g.sentences).sort((a, b) => a.word.spelling.localeCompare(b.word.spelling));
  assert.deepEqual(material(groups), material([original]));
  const state = f.store.snapshot();
  f.reopen();
  assert.deepEqual(f.store.snapshot(), state);
  assert.equal(f.preview().dueCount, 7);
  f.act({ ...f.context(), session: 'review', type: 'advance_judgment', word: second });
  while (f.day().review?.phase === 'judgment') {
    const word = f.day().review?.queue[0];
    assert.ok(word);
    f.act({ ...f.context(), session: 'review', type: 'choose_judgment', word, judgment: 'clear' });
    f.act({ ...f.context(), session: 'review', type: 'advance_judgment', word });
  }
  f.finishSpelling('review');
  f.act({ ...f.context(), type: 'complete_review' });
  assert.equal(f.day().id, groups[1]?.id);
  assert.deepEqual(f.day().reviewWords, original.reviewWords.slice(3, 6));
  assert.equal(f.preview().dueCount, 4);
});
test('finishing a mixed next-day review opens its own new-word window without another begin', async (t) => {
  const f = await fixture(t, 1, 1);
  f.begin({ deck: words.slice(0, 1) });
  f.prepare();
  f.group();
  assert.equal(f.day().phase, 'finished');
  f.setDate('2026-11-18T02:00:00Z');
  f.begin();
  const review = f.day();
  const word = review.review?.queue[0];
  assert.ok(word);
  assert.equal(review.phase, 'review');
  assert.ok(review.writingRequired !== false);
  f.act({ ...f.context(), type: 'choose_judgment', session: 'review', word, judgment: 'clear' });
  f.act({ ...f.context(), type: 'advance_judgment', session: 'review', word });
  f.finishSpelling('review');
  const sessionId = f.store.snapshot().planning.sessions.at(-1)?.id;
  f.act({ ...f.context(), type: 'complete_review' });
  f.reopen();
  assert.equal(f.preview().dueCount, 0);
  assert.equal(f.day().id, review.id);
  assert.equal(f.day().phase, 'learning');
  assert.equal(f.day().paused, false);
  assert.equal(f.store.snapshot().planning.sessions.at(-1)?.id, sessionId);
  assert.notEqual(f.visit().word.spelling, word.spelling);
  assert.equal(f.preview().completedNewCount, 0);
});

test('after local midnight only confirmed translations become reviews, unfinished senses restart and can later be reviewed', async (t) => {
  const f = await fixture(t, 2, 2);
  const deck = words.slice(0, 2);
  f.begin({ deck });
  f.prepare();
  f.finishMemory();
  f.finishSpelling();
  f.startWriting();
  f.translate();
  const task = currentTranslation(f.day());
  assert.ok(task);
  f.act({
    ...f.context(),
    type: 'submit_translation',
    taskId: task.id,
    answer: '保存但还未确认的原答',
  });
  const old = f.day();
  const done = old.flow?.completed[0]?.word;
  assert.ok(done);
  const pending = task.sentence.word;
  f.reopen();
  f.begin({ deck });
  assert.equal(f.day().id, old.id);
  assert.deepEqual(f.day().translation, old.translation);
  f.setDate('2026-11-17T16:00:00Z');
  const before = f.store.snapshot();
  assert.equal(f.preview(deck).dueCount, 1);
  assert.equal(f.preview(deck).newCount, 1);
  assert.equal(f.preview(deck).pendingDayId, null);
  assert.deepEqual(f.store.snapshot(), before);
  const planConflict = (error: unknown) =>
    error instanceof LearningError && error.code === 'MINI_PLAN_CONFLICT';
  assert.throws(
    () => f.act({ ...f.context(), type: 'advance_translation', taskId: task.id }),
    planConflict,
  );
  assert.throws(() => f.begin({ dayId: old.id, deck }), planConflict);
  f.act({
    target: 'daily',
    type: 'set_today_plan',
    date: '2026-11-18',
    timezone,
    mode: 'normal',
    wordLimit: 10,
    newWordLimit: 5,
  });
  assert.equal(f.day().flow?.targetDate, '2026-11-17');
  f.begin({ deck: [pending] });
  assert.deepEqual(f.day().reviewWords, [done]);
  assert.deepEqual(f.day().flow?.candidates, [pending]);
  assert.equal(f.day().learningWords.length, 0);
  const archived = f.store.snapshot().ledger.days.find((day) => day.id === old.id);
  assert.ok(archived?.archivedAt);
  assert.deepEqual(archived.translation, old.translation);
  assert.deepEqual(archived.learning, old.learning);
  assert.deepEqual(archived.flow, old.flow);
  f.act({
    ...f.context(),
    session: 'review',
    word: done,
    type: 'choose_judgment',
    judgment: 'clear',
  });
  f.act({ ...f.context(), session: 'review', word: done, type: 'advance_judgment' });
  f.finishSpelling('review');
  f.act({ ...f.context(), type: 'complete_review' });
  assert.deepEqual(f.visit().word, pending);
  assert.equal(f.visit().stage, 0);
  assert.deepEqual(
    f.day().sentences.find((item) => item.word.spelling === pending.spelling),
    old.sentences.find((item) => item.word.spelling === pending.spelling),
  );
  f.group();
  assert.equal(f.preview([pending]).completedNewCount, 1);
  f.setDate('2026-11-18T16:00:00Z');
  f.reopen();
  f.begin({ deck: [pending] });
  assert.ok(f.day().reviewWords.some((word) => word.spelling === pending.spelling));
});

test('a queued pre-midnight answer keeps its occurrence date and never resumes the former window', async (t) => {
  const f = await fixture(t, 1, 1);
  const deck = words.slice(0, 1);
  f.begin({ deck });
  f.prepare();
  const oldId = f.day().id;
  const visit = f.visit();
  const occurredAt = swiftTime(new Date('2026-11-17T15:59:59Z'));
  const pending = miniCommandSchema.parse({
    requestId: randomUUID(),
    expectedRevision: f.store.snapshot().revision,
    occurredAt,
    action: {
      ...f.context(),
      type: 'window_advance',
      session: 'learning',
      word: visit.word,
      visitId: visit.id,
      remembered: true,
    },
  });
  f.setDate('2026-11-17T16:00:01Z');
  const receipt = f.store.command(pending);
  assert.equal(f.day().flow?.window.events.at(-1)?.confirmedAt, occurredAt);
  assert.equal(f.day().flow?.targetDate, '2026-11-17');
  assert.equal(f.preview(deck).pendingDayId, null);
  assert.deepEqual(f.store.command(pending), receipt);
  f.begin({ deck });
  assert.notEqual(f.day().id, oldId);
  assert.equal(f.visit().stage, 0);
  const onToday = f.store.snapshot();
  assert.deepEqual(f.store.command(pending), onToday);
});

test('a changed book releases last night’s active card without enrolling it in today’s new words or reviews', async (t) => {
  const f = await fixture(t, 3, 3);
  f.begin({ deck: words.slice(0, 3) });
  f.prepare();
  f.memory();
  const old = f.day();
  assert.equal(old.flow?.window.events.length, 1);
  const freshDeck = words.slice(6, 7);
  f.setDate('2026-11-17T16:00:00Z');
  const plan = f.preview(freshDeck);
  assert.equal(plan.dueCount, 0);
  assert.equal(plan.newCount, 1);
  assert.deepEqual(plan.pendingGroups, []);
  f.begin({ deck: freshDeck });
  assert.deepEqual(f.day().flow?.candidates, freshDeck);
  assert.deepEqual(f.day().flow?.window.events, []);
  assert.equal(f.visit().stage, 0);
  assert.deepEqual(
    f.store.snapshot().ledger.days.find((day) => day.id === old.id)?.flow?.window,
    old.flow?.window,
  );
});

test('v2 lowering today goal and group preserves a pending chosen card until its real next action', async (t) => {
  const f = await fixture(t, 4, 4);
  f.begin();
  f.prepare();
  for (let i = 0; i < 100 && f.day().flow?.groupWords.length === 0; i++) f.memory();
  while (f.visit().stage === 0) f.memory();
  const current = f.visit();
  const ctx = {
    ...f.context(),
    session: 'learning' as const,
    word: current.word,
    visitId: current.id,
  };
  f.act({ ...ctx, type: 'window_choose', remembered: false, draft: '未确认的原始草稿' });
  const chosen = structuredClone(f.visit());
  f.act({
    type: 'set_today_plan',
    target: 'daily',
    date: '2026-11-17',
    timezone,
    mode: 'normal',
    wordLimit: 1,
    newWordLimit: 1,

    dailyNewGoal: 1,
    groupSize: 1,
  });
  assert.deepEqual(f.visit(), chosen);
  assert.equal(f.day().learning, undefined);
  assert.equal(f.preview().completedNewCount, 0);
  f.reopen();
  assert.deepEqual(f.visit(), chosen);
  f.act({ ...ctx, type: 'window_advance' });
  assert.equal(f.day().flow?.dailyNewGoal, 1);
  assert.equal(f.day().flow?.groupSize, 1);
  assert.equal(f.day().learning?.words.length, 1);
  assert.ok(
    f
      .day()
      .flow?.window.members.some(
        (member) => member.word.spelling === current.word.spelling && member.stage === 0,
      ),
  );
  const event = f.day().flow?.window.events.at(-1);
  assert.equal(event?.draft, chosen.draft);
  assert.equal(event?.remembered, false);
  f.finishSpelling();
  f.startWriting();
  f.translate();
  assert.equal(f.preview().completedNewCount, 1);
  assert.equal(f.day().paused, true);
});

test('v2 same-clock help uses judgment provenance so post-selection audio never changes the saved initial recall', async (t) => {
  for (const beforeChoice of [true, false])
    await t.test(
      beforeChoice ? 'chat before choice prevents Good' : 'audio after choice preserves Good',
      async (t) => {
        const f = await fixture(t, 1, 1);
        f.begin();
        f.prepare();
        f.group();
        f.setDate('2026-11-18T02:00:00Z');
        f.begin();
        const word = f.day().review?.queue[0];
        assert.ok(word);
        const ctx = { ...f.context(), session: 'review' as const, word };
        const expose = () =>
          f.act(
            {
              ...ctx,
              type: 'record_exposure',
              kind: 'potentialHelp',
              source: beforeChoice ? 'chat' : 'audio',
              focusIds: [],
            },
            false,
          );
        if (beforeChoice) expose();
        f.act({ ...ctx, type: 'choose_judgment', judgment: 'clear' }, false);
        if (!beforeChoice) expose();
        const exposure = f.store.snapshot().teaching.exposures.at(-1);
        const first = f.day().review?.judgmentEvents[0];
        assert.equal(exposure?.at, first?.selectedAt);
        assert.equal(exposure?.beforeJudgmentCount, beforeChoice ? 0 : 1);
        f.act({ ...ctx, type: 'advance_judgment', markWrong: false });
        f.finishSpelling('review');
        f.act({ ...f.context(), type: 'complete_review' });
        const rating = f.store
          .snapshot()
          .scheduling.flow.events.find(
            (event) =>
              event.kind === 'review' &&
              event.sourceId === ctx.dayId &&
              event.evidence === 'self_report',
          );
        assert.ok(rating);
        assert.equal(rating.meaning, beforeChoice ? null : 'Good');
        assert.equal(rating.nextDay, beforeChoice);
      },
    );
});

test('an English review question exposes the spelling while a revealed or consulted answer still disqualifies meaning recall', async (t) => {
  for (const scenario of ['plain', 'fuzzy', 'forgotten', 'sentence audio', 'undo'] as const)
    await t.test(scenario, async (t) => {
      const f = await fixture(t, 1, 1);
      f.begin();
      f.prepare();
      f.group();
      f.setDate('2026-11-18T02:00:00Z');
      f.begin();
      const word = f.day().review?.queue[0];
      assert.ok(word);
      const ctx = { ...f.context(), session: 'review' as const, word };
      const view = () => f.act({ ...ctx, type: 'record_card_view' }, false);
      view();
      const prompt = f.store.snapshot().teaching.exposures.at(-1);
      assert.equal(prompt?.reviewPrompt, true);
      assert.equal(prompt.beforeJudgmentCount, 0);
      if (scenario === 'sentence audio')
        f.act(
          {
            ...ctx,
            type: 'record_exposure',
            kind: 'potentialHelp',
            source: 'audio',
            audioKind: 'sentence',
            focusIds: [],
          },
          false,
        );
      if (scenario === 'undo') {
        f.act({ ...ctx, type: 'choose_judgment', judgment: 'forgotten' }, false);
        view();
        const revealed = f.store.snapshot().teaching.exposures.at(-1);
        assert.equal(revealed?.reviewPrompt, undefined);
        assert.equal(revealed?.beforeJudgmentCount, 1);
        f.act({ ...ctx, type: 'clear_judgment' }, false);
      }
      const judgment = scenario === 'fuzzy' || scenario === 'forgotten' ? scenario : 'clear';
      f.act({ ...ctx, type: 'choose_judgment', judgment }, false);
      view();
      f.act({ ...ctx, type: 'advance_judgment' });
      if (judgment !== 'clear') {
        f.act({ ...ctx, type: 'choose_judgment', judgment: 'clear' });
        f.act({ ...ctx, type: 'advance_judgment' });
      }
      f.finishSpelling('review');
      f.act({ ...f.context(), type: 'complete_review' });
      const results = f.store
        .snapshot()
        .scheduling.flow.events.filter(
          (event) => event.kind === 'review' && event.sourceId === ctx.dayId,
        );
      const supported = scenario === 'undo' || scenario === 'sentence audio';
      assert.equal(
        results[0]?.meaning,
        supported ? null : judgment === 'clear' ? 'Good' : judgment === 'fuzzy' ? 'Hard' : 'Again',
      );
      assert.equal(results[0]?.nextDay, supported);
      assert.equal(results[1]?.spelling, null);
      assert.equal(results[1]?.nextDay, supported);
      assert.ok(f.day().review?.spellingAttempts[0]?.lastPotentialHelpAt);
    });
});

test('repair of a proved old prompt preserves raw evidence, original dates and audit history and is idempotent', async (t) => {
  const f = await fixture(t, 1, 1);
  f.begin();
  f.prepare();
  f.group();
  f.setDate('2026-11-18T02:00:00Z');
  f.begin();
  const word = f.day().review?.queue[0];
  assert.ok(word);
  const ctx = { ...f.context(), session: 'review' as const, word };
  f.act({ ...ctx, type: 'record_card_view' });
  f.act({ ...ctx, type: 'choose_judgment', judgment: 'clear' });
  f.act({ ...ctx, type: 'advance_judgment' });
  f.finishSpelling('review');
  const baseline = f.store.snapshot().scheduling.flow;
  f.act({ ...f.context(), type: 'complete_review' });
  const corrected = f.store.snapshot();
  const state = structuredClone(corrected);
  state.scheduling.flow = baseline;
  const oldView = state.teaching.exposures.find((item) => item.reviewPrompt);
  assert.ok(oldView);
  delete oldView.reviewPrompt;
  delete oldView.beforeJudgmentCount;
  const at = swiftTime(new Date('2026-11-21T01:00:00Z'));
  observeMiniFlowScheduling(state, at - 86400);
  assert.equal(state.scheduling.flow.events.at(-2)?.meaning, null);
  assert.equal(state.scheduling.flow.events.at(-1)?.nextDay, true);
  const oldEvents = structuredClone(
    state.scheduling.flow.events.filter((item) => item.kind === 'review'),
  );
  const history = structuredClone(state.scheduling.flow.changes);
  const before = structuredClone(state.scheduling.flow.cards[0]);
  assert.equal(repairMiniReviewPromptSchedules(state, at), false);
  oldView.reviewPrompt = true;
  assert.equal(repairMiniReviewPromptSchedules(state, at), true);
  assert.deepEqual(state.ledger, corrected.ledger);
  assert.deepEqual(state.scheduling.flow.cards, corrected.scheduling.flow.cards);
  assert.deepEqual(state.scheduling.flow.changes.slice(0, -1), history);
  const audit = state.scheduling.flow.changes.at(-1);
  assert.deepEqual(audit?.replacedReviewEvents, oldEvents);
  assert.deepEqual(audit?.before, before);
  for (const prior of oldEvents) {
    const event = state.scheduling.flow.events.find((item) => item.id === prior.id);
    assert.equal(event?.occurredAt, prior.occurredAt);
    assert.equal(event?.recordedAt, prior.recordedAt);
    assert.deepEqual(event?.load, prior.load);
  }
  const saved = structuredClone(state);
  assert.equal(repairMiniReviewPromptSchedules(state, at + 3600), false);
  assert.deepEqual(state, saved);
  validateMiniFlowScheduling(state);
});

test('v2 an unsettled review stays due across midnight without inventing a completion or losing evidence', async (t) => {
  const f = await fixture(t, 1, 1);
  const word = words[0];
  assert.ok(word);
  f.begin({ deck: [word] });
  f.prepare();
  f.group();
  assert.equal(f.day().phase, 'finished');
  f.setDate('2026-11-18T02:00:00Z');
  f.begin();
  assert.equal(f.day().writingRequired, undefined);
  const ctx = { ...f.context(), session: 'review' as const, word };
  f.act({ ...ctx, type: 'record_exposure', kind: 'potentialHelp', source: 'chat', focusIds: [] });
  f.act({ ...ctx, type: 'choose_judgment', judgment: 'clear' });
  f.act({ ...ctx, type: 'advance_judgment', markWrong: false });
  f.finishSpelling('review');
  f.setDate('2026-11-19T02:00:00Z');
  const oldDay = f.day();
  assert.throws(
    () => f.act({ ...f.context(), type: 'complete_review' }),
    (error) => error instanceof LearningError && error.code === 'MINI_PLAN_CONFLICT',
  );
  assert.equal(f.preview().dueCount, 1);
  assert.equal(f.preview().pendingDayId, null);
  f.begin();
  assert.notEqual(f.day().id, oldDay.id);
  assert.equal(f.day().phase, 'review');
  assert.deepEqual(f.day().review?.judgmentEvents, []);
  const archived = f.store.snapshot().ledger.days.find((day) => day.id === oldDay.id);
  assert.deepEqual(archived?.review?.spellingAttempts, oldDay.review?.spellingAttempts);
  assert.equal(archived?.reviewFinishedAt, undefined);
  assert.equal(
    f.store.snapshot().scheduling.flow.events.filter((event) => event.kind === 'review').length,
    0,
  );
  assert.equal(
    f.day().reviewWords.some((item) => item.spelling === word.spelling),
    true,
  );
});

test('v2 cannot bypass the final review confirmation after spelling has finished', async (t) => {
  const f = await fixture(t, 1, 1);
  f.begin();
  f.prepare();
  f.group();
  f.setDate('2026-11-18T02:00:00Z');
  f.begin();
  const reviewId = f.day().id;
  const word = f.day().review?.queue[0];
  assert.ok(word);
  f.act({ ...f.context(), type: 'choose_judgment', session: 'review', word, judgment: 'clear' });
  f.act({ ...f.context(), type: 'advance_judgment', session: 'review', word });
  f.finishSpelling('review');
  assert.equal(f.day().reviewFinishedAt, undefined);
  assert.equal(f.preview().dueCount, 1);
  f.begin({ newGroup: true });
  assert.equal(f.day().id, reviewId);
  assert.equal(f.day().phase, 'review');
  f.act({ ...f.context(), type: 'complete_review' });
  assert.equal(f.preview().dueCount, 0);
});

test('home progress counts confirmed word senses across books, independently of level, order and today’s goal', async (t) => {
  const f = await fixture(t, 2, 2);
  f.begin();
  f.prepare();
  f.finishMemory();
  f.finishSpelling();
  f.startWriting();
  const [first, second] = miniWritingWords(f.day());
  assert.ok(first && second);
  const duplicate = { ...first, spelling: first.spelling.toUpperCase(), phonetic: 'alternate' };
  const otherSense = { ...first, meaning: '另一词义' };
  const outside = { spelling: 'outside', meaning: '书中未学词', phonetic: '' };
  const vocabulary = new MiniVocabularyStore(':memory:');
  const token = 'v'.repeat(64);
  const app = buildApp({ mini: { store: f.store, vocabulary, token } });
  t.after(() => app.close());
  function addBook(id: string, entries: MiniWord[]) {
    const roles = ['wordlist', 'dictionary'] as const;
    const book: MiniVocabularyImport = {
      id,
      name: id,
      activate: true,
      requestId: randomUUID(),
      expectedRevision: vocabulary.snapshot().revision,
      sources: roles.map((role) => ({
        id: role,
        title: role,
        url: 'https://example.org/words',
        version: '1',
        sha256: 'a'.repeat(64),
        license: 'Test',
        role,
      })),
      entries: entries.map((word, rank) => ({
        id: 'entry-' + rank,
        word,
        level: rank === 0 ? 'A1' : 'B2',
        rank,
        partOfSpeech: '',
        sourceEntry: word.spelling,
      })),
    };
    vocabulary.import(book);
  }
  function select(deckId: string | null, order: 'random' | 'source' = 'source') {
    vocabulary.activate({
      requestId: randomUUID(),
      expectedRevision: vocabulary.snapshot().revision,
      deckId,
      order,
    });
  }
  async function progress(deck = vocabulary.snapshot().activeWords) {
    const revision = f.store.snapshot().revision;
    const reply = await app.inject({
      method: 'POST',
      url: '/api/mini/plan-preview',
      headers: { authorization: 'Bearer ' + token },
      payload: { deck, timezone },
    });
    assert.equal(reply.statusCode, 200);
    const snapshot = miniPlanPreviewSchema.parse(reply.json());
    assert.equal(snapshot.revision, revision, 'The homepage only reads learning facts.');
    return snapshot.planContext.wordProgress;
  }

  addBook('first', [first, duplicate, otherSense, outside]);
  assert.deepEqual(await progress(), { lifetime: 0, bookId: 'first', completed: 0, total: 3 });
  const prompt = currentTranslation(f.day());
  assert.ok(prompt);
  f.act({
    ...f.context(),
    type: 'submit_translation',
    taskId: prompt.id,
    answer: '一份待确认的原答',
  });
  assert.deepEqual(await progress(), { lifetime: 0, bookId: 'first', completed: 0, total: 3 });
  f.act({ ...f.context(), type: 'advance_translation', taskId: prompt.id });
  assert.deepEqual(await progress(), { lifetime: 1, bookId: 'first', completed: 1, total: 3 });
  f.translate();

  for (const order of ['source', 'random'] as const) {
    select('first-a1', order);
    assert.equal(vocabulary.snapshot().activeWords.length, 1);
    assert.deepEqual(await progress(), { lifetime: 2, bookId: 'first', completed: 1, total: 3 });
  }
  addBook('second', [first, second, outside]);
  assert.deepEqual(await progress(), { lifetime: 2, bookId: 'second', completed: 2, total: 3 });
  select(null);
  assert.deepEqual(await progress([second, duplicate, first, otherSense, outside]), {
    lifetime: 2,
    bookId: null,
    completed: 2,
    total: 4,
  });
  f.setDate('2026-11-18T02:00:00Z');
  assert.equal(f.preview().completedNewCount, 0);
  assert.deepEqual(await progress([outside]), {
    lifetime: 2,
    bookId: null,
    completed: 0,
    total: 1,
  });
});

test('translation eligibility distinguishes the English question from a consulted answer across reopening', async (t) => {
  for (const scenario of ['source prompt', 'chat', 'lookup', 'unscoped view'] as const)
    await t.test(scenario, async (t) => {
      const f = await fixture(t, 1, 1);
      f.begin();
      f.prepare();
      f.finishMemory();
      f.finishSpelling();
      f.startWriting();
      const task = currentTranslation(f.day());
      assert.ok(task);
      assert.equal(task.direction, 'englishToChinese');
      const word = task.sentence.word;
      const ctx = { ...f.context(), word };
      f.setDate('2026-11-17T03:00:00Z');
      f.act({ ...ctx, type: 'record_card_view', taskId: task.id });
      f.act({ target: 'daily', type: 'hide_card', word });
      f.act({ ...ctx, type: 'record_card_view', taskId: task.id });
      f.act({
        ...ctx,
        type: 'record_exposure',
        source: 'audio',
        kind: 'potentialHelp',
        audioKind: 'sentence',
        translationPromptAudio: true,
        focusIds: [],
      });
      if (scenario === 'chat') {
        f.act({
          ...ctx,
          type: 'record_exposure',
          source: 'chat',
          kind: 'potentialHelp',
          focusIds: [],
        });
        f.setDate('2026-11-17T04:00:00Z');
      } else if (scenario === 'lookup') {
        f.act({ target: 'daily', type: 'record_browse_views', words: [word] });
        f.setDate('2026-11-17T04:00:00Z');
      } else if (scenario === 'unscoped view')
        f.act({ target: 'daily', type: 'record_card_view', word });
      f.reopen();
      f.translate();
      const source = f.store.pendingAssessments()[0];
      assert.ok(source);
      const eligibility = z
        .object({ meaning: z.boolean(), spelling: z.boolean(), taskHelp: z.boolean() })
        .parse(source.learningEvidence.eligibility);
      assert.deepEqual(eligibility, {
        meaning: scenario === 'source prompt',
        spelling: false,
        taskHelp: scenario === 'chat' || scenario === 'lookup',
      });
    });
});

test('spelling hints in the current review attempt remain supported after five minutes', async (t) => {
  const f = await fixture(t, 1, 1);
  f.begin();
  f.prepare();
  f.group();
  f.setDate('2026-11-18T02:00:00Z');
  f.begin();
  const word = f.day().review?.queue[0];
  assert.ok(word);
  const ctx = { ...f.context(), session: 'review' as const, word };
  f.act({ ...ctx, type: 'choose_judgment', judgment: 'clear' });
  f.act({ ...ctx, type: 'advance_judgment' });
  f.act({
    ...ctx,
    type: 'record_exposure',
    source: 'audio',
    kind: 'potentialHelp',
    audioKind: 'word',
    focusIds: [],
  });
  f.setDate('2026-11-18T02:10:00Z');
  f.finishSpelling('review');
  const first = f.day().review?.spellingAttempts[0];
  assert.ok(first?.helpDuringAttempt);
  f.act({ ...f.context(), type: 'complete_review' });
  const result = f.store.snapshot().scheduling.flow.events.find((e) => e.id.endsWith('/spelling'));
  assert.ok(result);
  assert.equal(result.spelling, null);
  assert.equal(result.evidence, 'learning');
});

test('finishing another translation inside the recall interval is an intervening target', async (t) => {
  const f = await fixture(t, 2, 2);
  f.begin();
  f.prepare();
  f.finishMemory();
  f.finishSpelling();
  f.startWriting();
  const first = currentTranslation(f.day());
  const secondWord = f
    .day()
    .flow?.translationWords.find((word) => word.spelling !== first?.sentence.word.spelling);
  assert.ok(first && secondWord);
  f.setDate('2026-11-17T02:30:00Z');
  f.act({ target: 'daily', type: 'record_browse_views', words: [secondWord] });
  f.translate();
  const second = currentTranslation(f.day());
  assert.equal(second?.sentence.word.spelling, secondWord.spelling);
  f.setDate('2026-11-17T02:31:30Z');
  f.translate();
  const source = f.store
    .pendingAssessments()
    .find((item) => item.word.spelling === secondWord.spelling);
  assert.ok(source);
  const eligibility = z.object({ meaning: z.boolean() }).parse(source.learningEvidence.eligibility);
  assert.equal(eligibility.meaning, true);
});
