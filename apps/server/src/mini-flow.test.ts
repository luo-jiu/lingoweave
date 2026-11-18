import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  miniSnapshotSchema,
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
  const act = (action: Action) => {
    now += 1;
    applyMiniAction(state, action, now, timezone);
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

test('v2 cannot advance concealed recall or make a helped initial failure into success', () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.memory();
  assert.throws(() => f.act({ ...f.windowCtx(), type: 'window_advance' }));
  f.act({ ...f.windowCtx(), type: 'window_choose', remembered: false });
  assert.throws(() => f.act({ ...f.windowCtx(), type: 'window_advance', remembered: true }));
  f.act({ ...f.windowCtx(), type: 'window_advance' });
  assert.equal(f.day().flow?.window.events.at(-1)?.remembered, false);
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
  const [a, b, c] = session.words;
  assert.ok(a && b && c);
  f.spell('wrong-a');
  f.spell(a.spelling);
  f.advanceSpell();
  f.spell();
  assert.equal(session.spellingState, 'readyToAdvance');
  f.advanceSpell();
  f.spell('wrong-c');
  f.spell(c.spelling);
  f.advanceSpell();
  assert.deepEqual(
    session.queue.map((word) => word.spelling),
    [a.spelling, c.spelling],
  );
  f.spell();
  f.advanceSpell();
  f.spell('wrong-c2');
  f.spell(c.spelling);
  f.advanceSpell();
  assert.deepEqual(
    session.queue.map((word) => word.spelling),
    [c.spelling],
  );
  f.spell('wrong-c3');
  assert.equal(session.spellingState, 'skipped');
  assert.equal(session.phase, 'spelling');
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
  const tomorrow = f.now + 86400;
  resumeMiniFlow(
    f.day(),
    { dailyNewGoal: 2, groupSize: 2, completedToday: 0 },
    tomorrow,
    timezone,
    words.slice(10),
  );
  f.day().paused = false;
  assert.equal(f.day().flow?.goalReached, false);
  assert.equal(f.day().flow?.completedBeforeRun, 0);
  assert.ok(currentMiniWindow(f.day())?.visit);
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
      flow: { dailyNewGoal: 1, groupSize: 1 },
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
  assert.deepEqual(day.review?.queue, day.reviewWords);
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
