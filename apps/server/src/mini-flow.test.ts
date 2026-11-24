import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MiniStore } from './mini-store.js';
import { miniAssessmentHash } from './mini-assessment-store.js';
import {
  miniSnapshotSchema,
  type MiniAssessmentApplication,
  type MiniDay,
  type MiniWord,
  type MiniWindow,
} from '@lingoweave/contracts';
import {
  applyMiniAction,
  currentMiniWindow,
  currentLearningWord,
  currentTranslation,
  miniCandidates,
  miniPreparationWords,
  miniWritingWords,
  reachedTranslation,
  resumeMiniFlow,
  swiftTime,
  validateMiniFacts,
} from './mini-study.js';
import {
  miniAIContext,
  miniFactHistory,
  miniWordContext,
  applyMiniTeachingAction,
  validateMiniTeaching,
} from './mini-teaching.js';
import { applyMiniMeasurementAction, observeMiniLearningCommand } from './mini-scheduler.js';

type Action = Parameters<typeof applyMiniAction>[1];
const timezone = 'Asia/Shanghai';
const initialAt = swiftTime(new Date('2026-11-17T02:00:00Z'));
const words: MiniWord[] = Array.from({ length: 70 }, (_, index) => ({
  spelling: `word${index}`,
  meaning: `义项${index}`,
  phonetic: '',
}));
function fixture(goal = 10, groupSize = 5, deck = words) {
  const state = miniSnapshotSchema.parse({
    schemaVersion: 1,
    revision: 0,
    imported: true,
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
  });
  let now = initialAt;
  const day = () => {
    const value = state.ledger.days.at(-1);
    assert.ok(value);
    return value;
  };
  const act = (action: Action, requestId?: string) => {
    now += 1;
    applyMiniAction(state, action, now, timezone, undefined, requestId);
    validateMiniFacts(state);
    miniSnapshotSchema.parse(state);
  };
  applyMiniAction(
    state,
    { type: 'begin', target: 'daily', deck, timezone, flowVersion: 'sliding-window-v2' },
    now,
    timezone,
    {
      limits: { wordLimit: 10, newWordLimit: 5 },
      writingRequired: true,
      flow: { dailyNewGoal: goal, groupSize, completedToday: 0 },
    },
  );
  state.planning.activeDayId = day().id;
  const ctx = () => ({ target: 'daily' as const, dayId: day().id });
  const materialWords = miniPreparationWords(day());
  for (let index = 0; index < materialWords.length; index += 5)
    act({
      ...ctx(),
      type: 'add_sentences',
      sentences: materialWords
        .slice(index, index + 5)
        .map((word) => ({ word, english: `Here is ${word.spelling}.`, chinese: '例句。' })),
    });
  const visit = () => {
    const value = currentMiniWindow(day())?.visit;
    assert.ok(value);
    return value;
  };
  const windowCtx = () => ({
    ...ctx(),
    session: day().phase === 'review' ? ('review' as const) : ('learning' as const),
    word: visit().word,
    visitId: visit().id,
  });
  const memory = (remembered = true, corrected = false) => {
    if (visit().stage === 0) act({ ...windowCtx(), type: 'window_advance', remembered });
    else {
      act({ ...windowCtx(), type: 'window_choose', remembered });
      if (corrected) act({ ...windowCtx(), type: 'window_correct' });
      act({ ...windowCtx(), type: 'window_advance' });
    }
  };
  const finishMemory = () => {
    for (let i = 0; i < 1000 && currentMiniWindow(day())?.visit; i++) memory();
    assert.equal(currentMiniWindow(day())?.visit, undefined);
  };
  const spell = (answer?: string) => {
    const session = day().phase === 'review' ? day().review : day().learning;
    assert.ok(session);
    const word = session.queue[0];
    assert.ok(word);
    act({
      ...ctx(),
      session: day().phase === 'review' ? 'review' : 'learning',
      type: 'submit_spelling',
      word,
      answer: answer ?? word.spelling,
      advanceOnCorrect: false,
    });
  };
  const advanceSpell = () => {
    const session = day().phase === 'review' ? day().review : day().learning;
    assert.ok(session?.queue[0]);
    act({
      ...ctx(),
      session: day().phase === 'review' ? 'review' : 'learning',
      type: 'advance_spelling',
      word: session.queue[0],
    });
  };
  const finishSpelling = () => {
    for (
      let i = 0;
      i < 200 && (day().phase === 'review' ? day().review : day().learning)?.phase === 'spelling';
      i++
    ) {
      spell();
      advanceSpell();
    }
  };
  const prepareWriting = () => {
    const value = day();
    const missing = miniWritingWords(value).filter(
      (word) =>
        !value.writingPrompts?.some((prompt) => prompt.sentence.word.spelling === word.spelling),
    );
    for (let i = 0; i < missing.length; i += 10)
      act({
        ...ctx(),
        type: 'publish_writing',
        prompts: missing.slice(i, i + 10).map((word) => ({
          id: randomUUID(),
          sentence: {
            word,
            english: `Please use ${word.spelling} today.`,
            chinese: '练习译文。',
          },
          direction:
            value.directions[
              miniWritingWords(value).findIndex((item) => item.spelling === word.spelling)
            ] ?? 'englishToChinese',
          focusIds: [],
        })),
      });
  };
  const translate = () => {
    const task = currentTranslation(day());
    assert.ok(task);
    act({ ...ctx(), type: 'submit_translation', taskId: task.id, answer: '原始翻译答案' });
    act({ ...ctx(), type: 'advance_translation', taskId: task.id });
  };
  return {
    state,
    day,
    act,
    ctx,
    visit,
    windowCtx,
    memory,
    finishMemory,
    spell,
    advanceSpell,
    finishSpelling,
    prepareWriting,
    translate,
    get now() {
      return now;
    },
  };
}

test('v2 interleaves per-word stages, services the unseen fifth word, and waits for confirmation', () => {
  const f = fixture();
  const shown = [];
  for (let i = 0; i < 4; i++) {
    shown.push(f.visit().word.spelling);
    f.memory();
  }
  assert.deepEqual(shown, ['word0', 'word1', 'word2', 'word3']);
  assert.equal(f.visit().word.spelling, 'word0');
  assert.equal(f.visit().stage, 1);
  const before = structuredClone(f.day().flow?.window.members);
  f.act({ ...f.windowCtx(), type: 'window_choose', remembered: true });
  assert.deepEqual(f.day().flow?.window.members, before);
  assert.equal(f.day().flow?.groupWords.length, 0);
  f.act({ ...f.windowCtx(), type: 'window_correct' });
  assert.deepEqual(f.day().flow?.window.members, before);
  const snapshot = miniSnapshotSchema.parse(JSON.parse(JSON.stringify(f.state)));
  assert.ok(snapshot.ledger.days[0]?.flow?.window.visit?.correctedAt);
  f.act({ ...f.windowCtx(), type: 'window_advance' });
  assert.equal(f.visit().word.spelling, 'word4');
  assert.equal(
    f.day().flow?.window.members.find((item) => item.word.spelling === 'word0')?.stage,
    0,
  );
  assert.equal(f.day().learningWords.length, 5);
});

test('window input identity names its next card; correction, admission and first spelling match the native trace', () => {
  const f = fixture(10, 5);
  for (let i = 0; i < 4; i++) {
    const id = randomUUID();
    assert.equal(f.visit().word.spelling, `word${i}`);
    f.act({ ...f.windowCtx(), type: 'window_advance', remembered: true }, id);
    assert.equal(f.visit().id, id);
  }
  assert.equal(f.visit().stage, 1);
  assert.equal(f.visit().word.spelling, 'word0');
  assert.throws(() => f.act({ ...f.windowCtx(), type: 'window_advance', markWrong: true }));
  f.act({ ...f.windowCtx(), type: 'window_choose', remembered: true });
  const originalVisit = f.visit().id;
  const id = randomUUID();
  f.act({ ...f.windowCtx(), type: 'window_advance', markWrong: true }, id);
  const last = f.day().flow?.window.events.at(-1);
  assert.equal(last?.id, originalVisit);
  assert.equal(last?.initial, true);
  assert.equal(last?.remembered, false);
  assert.equal(last?.correctedAt, last?.confirmedAt);
  assert.equal(f.visit().id, id);
  assert.equal(
    f.day().flow?.window.members.find((member) => member.word.spelling === 'word0')?.stage,
    0,
  );
  for (let i = 4; i < 9; i++) {
    assert.equal(f.visit().word.spelling, `word${i}`);
    const id = i === 8 ? '12345678-9abc-4def-8000-000000000001' : randomUUID();
    f.act({ ...f.windowCtx(), type: 'window_familiar', session: 'learning' }, id);
    if (i < 8) assert.equal(f.visit().id, id);
  }
  assert.deepEqual(f.day().learning?.spellingRounds, [{ round: 1, order: [2, 4, 3, 0, 1] }]);
  assert.deepEqual(
    f.day().learning?.queue.map((word) => word.spelling),
    ['word6', 'word8', 'word7', 'word4', 'word5'],
  );
  assert.deepEqual(
    f.day().flow?.groupWords.map((word) => word.spelling),
    ['word4', 'word5', 'word6', 'word7', 'word8'],
  );
});

test('v2 cannot advance concealed recall or make a helped initial failure into success', () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.memory();
  assert.throws(() => f.act({ ...f.windowCtx(), type: 'window_advance' }));
  f.act({ ...f.windowCtx(), type: 'window_choose', remembered: false });
  assert.throws(() => f.act({ ...f.windowCtx(), type: 'window_advance', remembered: true }));
  f.act({ ...f.windowCtx(), type: 'window_advance' });
  assert.equal(f.day().flow?.window.events.at(-1)?.remembered, false);
});

test('familiarity applies only to the open initial new-word card before a choice', () => {
  const f = fixture();
  const mark = () => f.act({ ...f.windowCtx(), session: 'learning', type: 'window_familiar' });
  f.act({ ...f.windowCtx(), type: 'window_choose', remembered: true });
  assert.throws(mark);
  f.act({ ...f.windowCtx(), type: 'window_advance' });
  for (let i = 0; i < 3; i++) f.memory();
  assert.equal(f.visit().stage, 1);
  assert.throws(mark);
  assert.equal(f.day().flow?.groupWords.length, 0);
  assert.ok(f.day().flow?.window.events.every((event) => event.selfReportedFamiliar === undefined));
});

test('v2 five permanently weak words never free a slot or admit an outside word', () => {
  const f = fixture();
  for (let i = 0; i < 40; i++) f.memory(false);
  assert.equal(f.day().learningWords.length, 5);
  assert.equal(f.day().flow?.candidateIndex, 5);
  assert.equal(f.day().flow?.groupWords.length, 0);
  assert.ok(f.day().flow?.window.members.every((member) => member.stage === 0));
});

test('v2 prepares reserves separately, frees a slot only after stage2 confirmation, freezes groups', () => {
  const f = fixture(10, 2);
  assert.equal(miniPreparationWords(f.day()).length, 15);
  assert.equal(f.day().learningWords.length, 5);
  assert.equal(f.day().learning, undefined);
  let completed = false;
  for (let i = 0; i < 30; i++) {
    if (f.visit().stage === 2) {
      const prior = f.day().learningWords.length;
      f.memory();
      assert.equal(f.day().learningWords.length, prior + 1);
      assert.equal(f.visit().stage, 0);
      assert.equal(f.visit().word.spelling, 'word5');
      completed = true;
      break;
    }
    f.memory();
  }
  assert.ok(completed);
  f.finishMemory();
  assert.equal(f.day().learning?.words.length, 2);
  assert.equal(f.day().flow?.window.members.length, 4);
  assert.equal(miniWritingWords(f.day()).length, 2);
  assert.equal(f.day().flow?.completed.length, 0);
});

test('v2 spelling retries only the immediately preceding first failures, pauses on green and third failure', () => {
  const f = fixture(3, 3);
  f.finishMemory();
  const session = f.day().learning;
  assert.ok(session);
  const [a, b, c] = session.queue;
  assert.deepEqual(new Set(session.queue), new Set(session.words));
  assert.notDeepEqual(session.queue, session.words);
  assert.ok(a && b && c);
  f.spell('  \t');
  const blankFirst = session.spellingAttempts.at(-1);
  assert.equal(session.spellingState, 'correcting');
  assert.equal(blankFirst?.answer, '  \t');
  assert.equal(blankFirst?.kind, 'first');
  assert.equal(blankFirst?.correct, false);
  assert.equal(blankFirst?.revealedAnswerAt, blankFirst?.submittedAt);
  assert.throws(() => f.spell('  \t'));
  f.spell(a.spelling);
  f.advanceSpell();
  f.spell();
  assert.equal(session.spellingState, 'readyToAdvance');
  f.advanceSpell();
  f.spell('wrong-c');
  f.spell('');
  assert.equal(session.spellingAttempts.at(-1)?.kind, 'correction');
  assert.equal(session.spellingAttempts.at(-1)?.encounter, 1);
  f.spell(c.spelling);
  f.advanceSpell();
  assert.deepEqual(
    session.queue.map((word) => word.spelling),
    [c.spelling, a.spelling],
  );
  f.spell('wrong-c2');
  f.spell(c.spelling);
  f.advanceSpell();
  f.spell();
  f.advanceSpell();
  assert.deepEqual(
    session.queue.map((word) => word.spelling),
    [c.spelling],
  );
  f.spell('');
  assert.equal(session.spellingState, 'skipped');
  assert.equal(session.phase, 'spelling');
  assert.equal(session.spellingAttempts.at(-1)?.answer, '');
  assert.throws(() => f.spell(c.spelling));
  f.advanceSpell();
  assert.equal(session.phase, 'finished');
  assert.equal(session.spellingSkips?.[0]?.round, 3);
  assert.equal(
    session.spellingAttempts.filter((item) => item.word.spelling === b.spelling).length,
    1,
  );
  f.act({ ...f.ctx(), type: 'complete_learning' });
  assert.equal(f.day().phase, 'translation');
});

test('v2 translation advances without feedback, preserves group spelling and keeps window tail across groups', () => {
  const f = fixture(4, 2);
  f.finishMemory();
  f.finishSpelling();
  f.prepareWriting();
  f.act({ ...f.ctx(), type: 'complete_learning' });
  const tail = structuredClone(f.day().flow?.window.members);
  f.translate();
  assert.equal(f.day().translationIndex, 1);
  assert.equal(f.day().flow?.completed.length, 1);
  assert.equal(f.day().translation[0]?.feedback, undefined);
  f.translate();
  assert.equal(f.day().phase, 'learning');
  assert.equal(f.day().flow?.groups.length, 1);
  assert.equal(f.day().flow?.groups[0]?.spelling.phase, 'finished');
  for (const member of tail ?? [])
    assert.deepEqual(
      f.day().flow?.window.members.find((item) => item.word.spelling === member.word.spelling),
      member,
    );
  f.finishMemory();
  f.finishSpelling();
  f.prepareWriting();
  f.act({ ...f.ctx(), type: 'complete_learning' });
  f.translate();
  f.translate();
  assert.equal(f.day().flow?.goalReached, true);
  assert.equal(f.day().paused, true);
  assert.equal(f.day().flow?.completed.length, 4);
  assert.ok((f.day().flow?.window.members.length ?? 0) > 0);
  assert.equal(f.day().flow?.groups.length, 2);
  const beforeTomorrow = structuredClone(f.day());
  assert.throws(() =>
    resumeMiniFlow(f.day(), { dailyNewGoal: 2, groupSize: 2 }, f.now + 86400, timezone),
  );
  assert.deepEqual(f.day(), beforeTomorrow);
  validateMiniFacts(f.state);
});

test('v2 daily50/group20 completes 20,20,10 and leaves at most four uncounted tail words', () => {
  const f = fixture(50, 20);
  for (const count of [20, 20, 10]) {
    f.finishMemory();
    assert.equal(f.day().learning?.words.length, count);
    f.finishSpelling();
    f.prepareWriting();
    f.act({ ...f.ctx(), type: 'complete_learning' });
    for (let i = 0; i < count; i++) f.translate();
  }
  assert.deepEqual(
    f.day().flow?.groups.map((group) => group.words.length),
    [20, 20, 10],
  );
  assert.equal(f.day().flow?.completed.length, 50);
  assert.equal(f.day().flow?.window.members.length, 4);
  assert.equal(f.day().flow?.candidates.length, 55);
});

test('v2 review failures enter card relearning with no new-word admissions and three-round spelling', () => {
  const reviewed = words.slice(0, 9);
  // Seed authentic completed legacy scheduling facts via an isolated separate record.
  const legacy: MiniDay = {
    id: '2026-11-16',
    startedAt: initialAt - 86400,
    reviewWords: [],
    learningWords: [],
    reviewSteps: [],
    directions: [],
    paused: false,
    phase: 'finished',
    finishedAt: initialAt - 86400,
    studiedWords: [],
    sentences: [],
    translation: [],
    translationDraft: '',
    translationIndex: 0,
    scheduleUpdates: [],
  };
  const state = miniSnapshotSchema.parse({
    schemaVersion: 1,
    revision: 0,
    imported: true,
    ledger: { days: [legacy] },
    reviewRecord: null,
    reviewHistory: [],
  });
  for (const word of reviewed)
    state.scheduling.cards.push({
      senseId: word.spelling,
      word,
      ability: 'spelling',
      introducedAt: initialAt - 86400,
      dueAt: initialAt - 1,
      lastServedAt: null,
      exposureKnown: true,
      lastAnswerExposureAt: null,
      state: 'review',
      fsrs: {
        due: initialAt - 1,
        stability: 1,
        difficulty: 5,
        elapsed_days: 1,
        scheduled_days: 1,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        state: 2,
        last_review: initialAt - 86400,
      },
    });
  let now = initialAt;
  applyMiniAction(
    state,
    { type: 'begin', target: 'daily', deck: words, timezone, flowVersion: 'sliding-window-v2' },
    now,
    timezone,
    {
      limits: { wordLimit: 10, newWordLimit: 5 },
      writingRequired: true,
      newGroup: true,
      flow: { dailyNewGoal: 1, groupSize: reviewed.length },
    },
  );
  const day = state.ledger.days.at(-1);
  assert.ok(day?.flow);
  state.planning.activeDayId = day.id;
  const act = (action: Action) => {
    applyMiniAction(state, action, ++now, timezone);
    validateMiniFacts(state);
  };
  const ctx = { target: 'daily' as const, dayId: day.id, session: 'review' as const };
  assert.equal(day.reviewWords.length, 9);
  for (let i = 0; i < 30 && day.review?.queue.length; i++) {
    const word = day.review?.queue[0];
    assert.ok(word);
    const count = day.review.judgmentEvents.filter(
      (event) => event.word.spelling === word.spelling,
    ).length;
    const judgment =
      word.spelling === reviewed[0]?.spelling ||
      (word.spelling === reviewed[1]?.spelling && count === 2)
        ? 'clear'
        : 'forgotten';
    act({ ...ctx, type: 'choose_judgment', word, judgment });
    act({ ...ctx, type: 'advance_judgment', word, markWrong: false });
  }
  assert.deepEqual(day.review?.relearningWords, reviewed.slice(2));
  assert.ok(day.review?.relearning?.visit);
  const reviewVisit = day.review.relearning.visit;
  assert.throws(() =>
    act({
      ...ctx,
      session: 'learning',
      type: 'window_familiar',
      word: reviewVisit.word,
      visitId: reviewVisit.id,
    }),
  );
  assert.deepEqual(currentLearningWord(day), day.review.relearning.visit.word);
  assert.deepEqual(
    miniAIContext(state, { timezone }, now).currentLearning?.word,
    day.review.relearning.visit.word,
  );
  applyMiniTeachingAction(
    state,
    {
      ...ctx,
      type: 'record_exposure',
      word: day.review.relearning.visit.word,
      kind: 'potentialHelp',
      source: 'audio',
      focusIds: [],
    },
    ++now,
  );
  validateMiniTeaching(state);
  assert.equal(day.learningWords.length, 0);
  for (let i = 0; i < 30 && day.review?.relearning?.visit; i++) {
    const visit: NonNullable<MiniWindow['visit']> = day.review.relearning.visit;
    const wc = { ...ctx, word: visit.word, visitId: visit.id };
    if (visit.stage > 0) act({ ...wc, type: 'window_choose', remembered: true });
    const before: MiniWindow = structuredClone(day.review.relearning);
    assert.equal(
      applyMiniMeasurementAction(
        state,
        { ...ctx, type: 'open_dictation', word: visit.word },
        ++now,
        now,
      ),
      true,
    );
    const dictationId = state.practice.activeDictationId;
    assert.ok(dictationId);
    applyMiniMeasurementAction(
      state,
      { ...ctx, type: 'submit_dictation', dictationId, answer: visit.word.spelling },
      ++now,
      now,
    );
    applyMiniMeasurementAction(state, { ...ctx, type: 'close_dictation', dictationId }, ++now, now);
    assert.deepEqual(day.review.relearning, before);
    assert.equal(state.practice.activeDictationId, null);
    if (visit.stage === 0) act({ ...wc, type: 'window_advance', remembered: true });
    else {
      act({ ...wc, type: 'window_advance' });
    }
  }
  assert.equal(day.review?.phase, 'spelling');
  assert.equal(day.review?.spellingPolicy, 'retry-errors-v2');
  assert.equal(
    day.review?.relearning?.events.filter((event) => event.remembered && event.stage === 2).length,
    7,
  );
  assert.deepEqual(new Set(day.review?.queue), new Set(day.reviewWords));
  assert.notDeepEqual(day.review?.queue, day.reviewWords);
  assert.equal(day.learningWords.length, 0);
  assert.equal(day.translation.length, 0);
});

test('v2 unfinished admitted words are excluded from legacy ten-minute probe scheduling', () => {
  const f = fixture();
  const word = f.day().learningWords[0];
  assert.ok(word);
  f.state.scheduling.cards.push({
    senseId: 'test',
    word,
    ability: 'spelling',
    introducedAt: f.now,
    dueAt: f.now + 600,
    nextProbeAt: f.now + 600,
    lastServedAt: null,
    exposureKnown: true,
    lastAnswerExposureAt: f.now,
    state: 'introduced',
    fsrs: null,
  });
  const candidates = miniCandidates(f.state.ledger, words, f.now + 900, f.state.scheduling);
  assert.equal(
    candidates.due.some((item) => item.word.spelling === word.spelling),
    false,
  );
  assert.equal(
    candidates.candidates.some((item) => item.spelling === word.spelling),
    false,
  );
});

test('v2 validation rejects fabricated completion or a removed weak window member', () => {
  const f = fixture();
  const damaged = structuredClone(f.state);
  damaged.ledger.days[0]?.flow?.window.members.pop();
  assert.throws(() => validateMiniFacts(damaged));
  const removed = f.day().flow?.window.visit;
  assert.ok(removed);
  f.day().flow?.completed.push({
    word: removed.word,
    attemptId: randomUUID(),
    at: f.now,
    date: '2026-11-17',
  });
  assert.throws(() => validateMiniFacts(f.state));
});

test('v2 pauses preserve the exact unconfirmed card and reject stale visits after advance', () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.memory();
  const oldContext = f.windowCtx();
  f.act({ ...oldContext, type: 'window_choose', remembered: true, draft: 'real draft' });
  const pending = structuredClone(f.visit());
  f.act({ ...f.ctx(), type: 'pause', paused: true });
  assert.throws(() => f.act({ ...oldContext, type: 'window_advance' }));
  assert.deepEqual(f.visit(), pending);
  f.act({ ...f.ctx(), type: 'pause', paused: false });
  assert.deepEqual(f.visit(), pending);
  f.act({ ...oldContext, type: 'window_advance' });
  assert.throws(() => f.act({ ...oldContext, type: 'window_advance' }));
  assert.equal(f.day().flow?.window.events.at(-1)?.draft, 'real draft');
});

test('v2 a depleted small book finishes a short group without waiting for nonexistent candidates', () => {
  const f = fixture(20, 20, words.slice(0, 1));
  f.finishMemory();
  assert.equal(f.day().learning?.words.length, 1);
  f.finishSpelling();
  f.prepareWriting();
  f.act({ ...f.ctx(), type: 'complete_learning' });
  f.translate();
  assert.equal(f.day().phase, 'finished');
  assert.equal(f.day().flow?.completed.length, 1);
  assert.equal(f.day().flow?.groups[0]?.words.length, 1);
  assert.equal(f.day().flow?.goalReached, false);
});

test('v2 cannot publish a writing target before its three memory stages pass', () => {
  const f = fixture();
  const word = f.visit().word;
  assert.throws(() =>
    f.act({
      ...f.ctx(),
      type: 'publish_writing',
      prompts: [
        {
          id: randomUUID(),
          sentence: { word, english: 'Independent prompt.', chinese: '独立练习题。' },
          direction: 'englishToChinese',
          focusIds: [],
        },
      ],
    }),
  );
  assert.equal(f.day().flow?.translationWords.length, 0);
});

test('v2 explicit resume preserves chosen cards and defers a smaller group until confirmation', () => {
  const f = fixture(10, 5);
  for (let i = 0; i < 50 && f.day().flow?.groupWords.length === 0; i++) f.memory();
  while (f.visit().stage === 0) f.memory();
  f.act({
    ...f.windowCtx(),
    type: 'window_choose',
    remembered: false,
    draft: 'pending original draft',
  });
  const visit = structuredClone(f.visit());
  resumeMiniFlow(f.day(), { dailyNewGoal: 10, groupSize: 1, completedToday: 0 }, f.now, timezone);
  assert.deepEqual(f.visit(), visit);
  assert.equal(f.day().learning, undefined);
  f.act({ ...f.windowCtx(), type: 'window_advance' });
  assert.equal(f.day().learning?.words.length, 1);
  assert.ok(
    f
      .day()
      .flow?.window.members.some(
        (member) => member.word.spelling === visit.word.spelling && member.stage === 0,
      ),
  );
});

test('v2 teaching history keeps old group spelling identities, visits and confirmed translation', () => {
  const f = fixture(2, 1);
  f.finishMemory();
  f.finishSpelling();
  f.prepareWriting();
  const before = miniFactHistory(f.state).filter((item) => item.kind === 'spelling');
  assert.equal(before.length, 1);
  f.act({ ...f.ctx(), type: 'complete_learning' });
  f.translate();
  assert.deepEqual(
    miniFactHistory(f.state).filter((item) => item.kind === 'spelling'),
    before,
  );
  f.finishMemory();
  f.finishSpelling();
  const history = miniFactHistory(f.state);
  assert.equal(history.filter((item) => item.kind === 'spelling').length, 2);
  assert.equal(new Set(history.map((item) => item.id)).size, history.length);
  assert.equal(
    history.filter((item) => item.kind === 'memory').length,
    f.day().flow?.window.events.length,
  );
  assert.equal(
    history.find((item) => item.kind === 'translation')?.data.confirmedAt,
    f.day().translation[0]?.confirmedAt,
  );
  assert.equal(miniAIContext(f.state, { timezone }, f.now).summary.firstSpellingAttempts, 2);
  validateMiniTeaching(f.state);
});

test('v2 preparation words are queryable without invented study activity and can reuse a saved focus', () => {
  const f = fixture();
  const reserve = f.day().flow?.candidates[6];
  assert.ok(reserve);
  const before = miniAIContext(f.state, { timezone }, f.now).summary;
  assert.equal(
    miniWordContext(f.state, { word: reserve }).history.items.filter(
      (item) => item.kind !== 'material',
    ).length,
    0,
  );
  applyMiniTeachingAction(
    f.state,
    {
      ...f.ctx(),
      type: 'create_focus',
      words: [reserve],
      expression: 'a useful phrase',
      explanation: '使用说明',
      reason: '复用常见搭配',
    },
    f.now,
  );
  validateMiniTeaching(f.state);
  assert.deepEqual(miniAIContext(f.state, { timezone }, f.now).summary, before);
  assert.equal(
    f.day().learningWords.some((word) => word.spelling === reserve.spelling),
    false,
  );
});

test('v2 window visits record visible English exposure and pause closes it without granting recall', () => {
  const f = fixture();
  const first = f.visit().word;
  observeMiniLearningCommand(
    f.state,
    { type: 'begin', target: 'daily', deck: words, timezone, flowVersion: 'sliding-window-v2' },
    f.now,
  );
  assert.deepEqual(f.state.scheduling.visibleWord, first);
  assert.equal(f.state.scheduling.cards[0]?.lastAnswerExposureAt, f.now);
  const action: Action = { ...f.windowCtx(), type: 'window_advance', remembered: true };
  f.act(action);
  observeMiniLearningCommand(f.state, action, f.now);
  assert.deepEqual(f.state.scheduling.visibleWord, f.visit().word);
  assert.equal(
    f.state.scheduling.cards.find((card) => card.word.spelling === first.spelling)?.lastServedAt,
    f.now,
  );
  assert.ok(f.state.scheduling.cards.every((card) => card.fsrs === null));
  const pause: Action = { ...f.ctx(), type: 'pause', paused: true };
  f.act(pause);
  observeMiniLearningCommand(f.state, pause, f.now);
  assert.equal(f.state.scheduling.visibleWord, null);
});

test('the current translation group allows revisions without repeating completion or discarding drafts', (t) => {
  const f = fixture(5, 3);
  f.finishMemory();
  f.finishSpelling();
  f.prepareWriting();
  f.act({ ...f.ctx(), type: 'complete_learning' });
  const directory = mkdtempSync(join(tmpdir(), 'lingoweave-revise-'));
  const database = join(directory, 'mini.sqlite');
  let at = f.now;
  const open = () =>
    new MiniStore(database, { now: () => new Date((at + 978307200) * 1000), timezone });
  let study = open();
  t.after(() => {
    study.close();
    rmSync(directory, { recursive: true, force: true });
  });
  study.importLegacy({
    requestId: randomUUID(),
    ledger: f.state.ledger,
    reviewRecord: null,
    reviewHistory: [],
    timezone,
  });
  const day = () => {
    const current = study.snapshot().ledger.days.at(-1);
    assert.ok(current);
    return current;
  };
  const ctx = f.ctx();
  const command = (action: Action) => ({
    requestId: randomUUID(),
    expectedRevision: study.snapshot().revision,
    action,
  });
  const send = (action: Action) => {
    at++;
    return study.command(command(action));
  };
  const submit = (answer: string) => {
    const task = currentTranslation(day());
    assert.ok(task);
    send({ ...ctx, type: 'submit_translation', taskId: task.id, answer });
    const attempt = day().translation.at(-1);
    assert.ok(attempt);
    return attempt;
  };
  const first = submit('original one');
  send({ ...ctx, type: 'advance_translation', taskId: first.task.id });
  const secondTask = currentTranslation(day());
  assert.ok(secondTask);
  send({ ...ctx, type: 'translation_draft', taskId: secondTask.id, draft: 'in progress' });
  const completed = day().flow?.completed;
  const schedules = study.snapshot().scheduling.flow;
  const revise = {
    ...ctx,
    type: 'revise_translation' as const,
    taskId: first.task.id,
    attemptId: first.id,
    answer: 'new one',
  };
  const retry = command(revise);
  at++;
  const revised = study.command(retry);
  assert.deepEqual(study.command(retry), revised);
  assert.equal(currentTranslation(day())?.id, secondTask.id);
  assert.equal(day().translationDraft, 'in progress');
  assert.deepEqual(day().flow?.completed, completed);
  assert.deepEqual(study.snapshot().scheduling.flow, schedules);
  const version = day().translation[0]?.revisions?.[0];
  assert.ok(version);
  assert.equal(day().translation[0]?.answer, 'original one');
  assert.equal(study.assessmentSource(first.id)?.answer, 'original one');
  const revisedSource = study.assessmentSource(version.id);
  assert.equal(revisedSource?.attemptId, first.id);
  assert.equal(revisedSource?.answer, 'new one');
  assert.equal(revisedSource?.learningEvidence.originalAnswer, 'original one');
  assert.throws(() => send({ ...revise, answer: 'stale edit' }));
  assert.throws(() => study.aiCommand(command({ ...revise, attemptId: version.id })));
  const prior = study.snapshot().revision;
  assert.equal(send({ ...revise, attemptId: version.id, answer: ' new one ' }).revision, prior);
  assert.equal(reachedTranslation(day(), first.task.id)?.id, first.task.id);
  assert.equal(reachedTranslation(day(), ctx.dayId + '/2'), undefined);

  const second = submit('original two');
  send({
    ...ctx,
    type: 'revise_translation',
    taskId: second.task.id,
    attemptId: second.id,
    answer: 'new two',
  });
  const secondVersion = day().translation[1]?.revisions?.[0];
  assert.ok(secondVersion);
  assert.equal(study.assessmentSource(secondVersion.id), undefined);
  send({ ...ctx, type: 'advance_translation', taskId: second.task.id });
  assert.equal(study.assessmentSource(secondVersion.id)?.answer, 'new two');
  const third = submit('third');
  send({ ...ctx, type: 'advance_translation', taskId: third.task.id });
  assert.equal(day().flow?.completed.length, 3);
  assert.equal(day().flow?.groups[0]?.translationAttemptIds.length, 3);
  assert.equal(reachedTranslation(day(), first.task.id), undefined);
  assert.throws(() => send({ ...revise, attemptId: version.id, answer: 'closed group' }));
  const saved = study.snapshot();
  study.close();
  study = open();
  assert.deepEqual(study.snapshot(), saved);

  const application = (id: string, summary: string): MiniAssessmentApplication => {
    const source = study.assessmentSource(id);
    assert.ok(source);
    const hash = miniAssessmentHash(source);
    const observation = {
      outcome: 'incorrect' as const,
      explanation: '测试中的目标词有误。',
      evidenceIds: [id],
    };
    return {
      requestId: randomUUID(),
      source,
      result: {
        sourceId: id,
        inputHash: hash,
        expressionGrade: 'off_meaning',
        meaning: observation,
        spelling: observation,
        usage: observation,
        summary,
        strengths: [],
        improvements: [],
        referenceTranslation: source.question.english,
        uncertainties: [],
      },
      trace: {
        model: 'test',
        effort: 'high',
        threadId: null,
        rulesVersion: 'mini-assessment-v1',
        skillHash: hash,
        promptHash: hash,
        inputHash: hash,
        startedAt: at,
        assessedAt: at,
      },
    };
  };
  const report = () => study.translationReview({ date: '2026-11-17', timezone }, () => null);
  const latest = application(version.id, '点评修改稿');
  const flowBefore = study.snapshot().scheduling.flow;
  const receipt = study.applyAssessment(latest);
  assert.equal(receipt.scheduling.affectedEvents, 0);
  assert.deepEqual(study.snapshot().scheduling.flow, flowBefore);
  const reviewed = report().entries.find((entry) => entry.attemptId === first.id);
  assert.equal(reviewed?.commentary?.summary, latest.result.summary);
  assert.equal(reviewed?.answer, version.answer);
  const lateOriginal = application(first.id, '迟到的首答点评');
  study.applyAssessment(lateOriginal);
  const afterAssessment = study.snapshot();
  assert.deepEqual(
    report().entries.find((entry) => entry.attemptId === first.id),
    reviewed,
  );
  assert.equal(report().entries.length, 3);
  assert.deepEqual(afterAssessment.ledger, saved.ledger);
  assert.deepEqual(
    afterAssessment.scheduling.flow.events
      .filter((event) => event.kind === 'assessment')
      .map((event) => event.sourceId),
    [first.id],
  );
  assert.deepEqual(study.applyAssessment(latest), receipt);
  study.applyAssessment(lateOriginal);
  assert.deepEqual(study.snapshot(), afterAssessment);
  study.close();
  study = open();
  assert.deepEqual(
    report().entries.find((entry) => entry.attemptId === first.id),
    reviewed,
  );
});
