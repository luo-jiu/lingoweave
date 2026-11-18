import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { miniCommandSchema, type MiniWord } from '@lingoweave/contracts';
import { z } from 'zod';
import { LearningError } from './learning-store.js';
import { MiniStore } from './mini-store.js';
import {
  currentMiniWindow,
  currentTranslation,
  miniPreparationWords,
  miniWritingWords,
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
  const preview = () => store.planPreview({ deck: words, timezone }).planContext;
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
    startWriting,
    translate,
    group,
    setDate(value: string) {
      date = new Date(value);
    },
    reopen() {
      store.close();
      store = new MiniStore(filename, { timezone, now: () => date });
    },
  };
}

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

test('v2 all due words precede new learning, newGroup cannot bypass pending review, and next-day tail resumes intact', async (t) => {
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
  f.begin({ dayId: oldId });
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
  assert.equal(f.day().phase, 'finished');
  assert.equal(f.preview().hasDueReviews, false);
  f.begin({ dayId: oldId });
  assert.equal(f.day().id, oldId);
  assert.equal(f.day().phase, 'learning');
  assert.equal(f.day().paused, false);
  for (const member of tail ?? [])
    assert.deepEqual(
      f.day().flow?.window.members.find((item) => item.word.spelling === member.word.spelling),
      member,
    );
  assert.equal(f.day().flow?.completedBeforeRun, 0);
  assert.equal(f.preview().completedNewCount, 0);
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

test('v2 a review finished after midnight stays ahead of new words when its original evidence is already due again', async (t) => {
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
  f.act({ ...f.context(), type: 'complete_review' });
  assert.equal(f.day().review?.phase, 'finished');
  assert.equal(f.day().phase, 'learning');
  assert.equal(f.day().paused, true);
  assert.equal(f.day().flow?.window.events.length, 0);
  assert.equal(f.preview().hasDueReviews, true);
  assert.throws(
    () => f.memory(),
    (error) => error instanceof LearningError,
  );
  f.begin();
  assert.equal(f.day().phase, 'review');
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
