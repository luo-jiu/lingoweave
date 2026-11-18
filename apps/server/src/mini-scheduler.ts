import { createHash, randomUUID } from 'node:crypto';
import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  State,
  FSRSVersion,
  type Card,
} from 'ts-fsrs';
import type {
  MiniAction,
  MiniDictation,
  MiniMemoryCard,
  MiniProbe,
  MiniSnapshot,
  MiniWord,
} from '@lingoweave/contracts';
import { classifyMeasurement, defaultMeasurementRules } from './measurement.js';
import { LearningError } from './learning-store.js';
import {
  currentLearningWord,
  currentMiniWindow,
  sameWord,
  swiftTime,
  wordKey,
} from './mini-study.js';

const parameters = generatorParameters({
  request_retention: 0.9,
  enable_fuzz: false,
  enable_short_term: true,
  learning_steps: ['10m'],
  relearning_steps: ['10m'],
});
const scheduler = fsrs(parameters);
if (FSRSVersion !== 'v5.4.2 using FSRS-6.0')
  throw new Error('The mini scheduler requires the locked ts-fsrs 5.4.2 FSRS-6 runtime.');
const dateAt = (at: number) => new Date((at + 978_307_200) * 1000);
function requireFact(condition: unknown, message: string): asserts condition {
  if (!condition) throw new LearningError('MINI_MEASUREMENT_CONFLICT', message);
}
function senseId(word: MiniWord) {
  return `sense-${createHash('sha256').update(wordKey(word)).digest('hex')}`;
}
function serialized(card: Card) {
  const { due, last_review, ...rest } = card;
  return {
    ...rest,
    due: swiftTime(due),
    ...(last_review ? { last_review: swiftTime(last_review) } : {}),
  };
}
function hydrated(card: NonNullable<MiniMemoryCard['fsrs']>): Card {
  const { due, last_review, ...rest } = card;
  return {
    ...rest,
    state:
      card.state === 0
        ? State.New
        : card.state === 1
          ? State.Learning
          : card.state === 2
            ? State.Review
            : State.Relearning,
    due: dateAt(due),
    ...(last_review === undefined ? {} : { last_review: dateAt(last_review) }),
  };
}
export function miniMemory(state: MiniSnapshot, word: MiniWord) {
  return state.scheduling.cards.find((card) => card.senseId === senseId(word));
}
function introduce(
  state: MiniSnapshot,
  word: MiniWord,
  at: number,
  known: boolean,
): MiniMemoryCard {
  let card = miniMemory(state, word);
  if (!card) {
    card = {
      senseId: senseId(word),
      word,
      ability: 'spelling',
      introducedAt: at,
      dueAt: at + 600,
      lastServedAt: null,
      exposureKnown: known,
      lastAnswerExposureAt: null,
      state: 'introduced',
      fsrs: null,
    };
    state.scheduling.cards.push(card);
  }
  return card;
}
function expose(state: MiniSnapshot, word: MiniWord, at: number) {
  const card = introduce(state, word, at, true);
  card.exposureKnown = true;
  card.lastAnswerExposureAt = Math.max(card.lastAnswerExposureAt ?? -Infinity, at);
}
function serve(state: MiniSnapshot, word: MiniWord, at: number) {
  const card = introduce(state, word, at, false);
  card.lastServedAt = Math.max(card.lastServedAt ?? -Infinity, at);
  if (!card.fsrs) card.dueAt = at + 600;
  if ((card.practicePriority ?? 0) > 0) card.nextProbeAt = at + 600;
  state.scheduling.servedCount += 1;
}
function prioritizePractice(state: MiniSnapshot, word: MiniWord, at: number) {
  const card = introduce(state, word, at, true);
  if (card.priorityUpdatedAt !== undefined && card.priorityUpdatedAt >= at) return;
  card.practicePriority = 5;
  card.priorityUpdatedAt = at;
  card.nextProbeAt = at + 600;
}
/** Add conservative introduced targets from actual legacy evidence, never fabricated ratings. */
export function initializeMiniScheduling(state: MiniSnapshot) {
  const existing = new Set(state.scheduling.cards.map((card) => card.senseId));
  if (state.scheduling.parameters.weights.length === 0)
    state.scheduling.parameters.weights = [...parameters.w];
  for (const day of state.ledger.days) {
    for (const window of [day.flow?.window, day.review?.relearning])
      for (const event of window?.events ?? []) expose(state, event.word, event.confirmedAt);
    for (const event of day.memory?.events ?? []) expose(state, event.word, event.at);
    for (const reveal of day.memory?.reveals ?? []) expose(state, reveal.word, reveal.at);
    for (const item of day.studyMarkEvents ?? [])
      if (item.remembered) expose(state, item.word, item.at);
    for (const item of day.studiedWords) expose(state, item.word, item.at);
    for (const session of [
      day.review,
      day.learning,
      ...(day.flow?.groups.map((group) => group.spelling) ?? []),
    ]) {
      for (const item of session?.judgmentEvents ?? []) expose(state, item.word, item.selectedAt);
      for (const item of session?.spellingAttempts ?? []) {
        introduce(state, item.word, item.submittedAt, false);
        if (item.revealedAnswerAt !== undefined) expose(state, item.word, item.revealedAnswerAt);
      }
      if (session?.spellingPolicy !== 'retry-errors-v2')
        for (const skip of session?.spellingSkips ?? [])
          prioritizePractice(state, skip.word, skip.at);
    }
  }
  for (const record of [state.reviewRecord, ...state.reviewHistory]) {
    for (const item of record?.session.judgmentEvents ?? [])
      expose(state, item.word, item.selectedAt);
    for (const item of record?.session.spellingAttempts ?? []) {
      introduce(state, item.word, item.submittedAt, false);
      if (item.revealedAnswerAt !== undefined) expose(state, item.word, item.revealedAnswerAt);
    }
    for (const skip of record?.session.spellingSkips ?? [])
      prioritizePractice(state, skip.word, skip.at);
  }
  for (const item of state.teaching.exposures) expose(state, item.word, item.at);
  const legacy = new Map<string, { dueAt: number; recordedAt: number }>();
  for (const day of state.ledger.days)
    for (const item of day.scheduleUpdates) {
      const previous = legacy.get(wordKey(item.word));
      if (!previous || item.recordedAt >= previous.recordedAt) legacy.set(wordKey(item.word), item);
    }
  for (const card of state.scheduling.cards) {
    const prior = legacy.get(wordKey(card.word));
    if (!existing.has(card.senseId) && prior) card.dueAt = prior.dueAt;
  }
}
export function activeMiniProbe(state: MiniSnapshot): MiniProbe | undefined {
  return state.scheduling.probes.find(
    (probe) => probe.id === state.scheduling.activeProbeId && probe.status !== 'ended',
  );
}
function closeVisible(state: MiniSnapshot, at: number, expected?: MiniWord) {
  const word = state.scheduling.visibleWord;
  if (!word || (expected && !sameWord(word, expected))) return;
  const latestVisibleAt = state.scheduling.views.reduce(
    (latest, view) => (sameWord(view.word, word) ? Math.max(latest, view.at) : latest),
    -Infinity,
  );
  if (at < latestVisibleAt) return;
  state.scheduling.views.push({ id: randomUUID(), word, at });
  if (miniMemory(state, word)) expose(state, word, at);
  state.scheduling.visibleWord = null;
}
function showVisible(state: MiniSnapshot, word: MiniWord, at: number) {
  if (state.scheduling.visibleWord && !sameWord(state.scheduling.visibleWord, word))
    closeVisible(state, at);
  state.scheduling.views.push({ id: randomUUID(), word, at });
  state.scheduling.visibleWord = word;
}
function closePractice(state: MiniSnapshot, at: number) {
  const current = state.practice.dictations.find(
    (item) => item.id === state.practice.activeDictationId,
  );
  if (current && current.closedAt === undefined) {
    current.closedAt = at;
    closeVisible(state, at, current.word);
  }
  state.practice.activeDictationId = null;
}
function dictationExposure(
  state: MiniSnapshot,
  item: MiniDictation,
  at: number,
  kind: 'potentialHelp' | 'answerReveal',
) {
  const day = state.ledger.days.find((day) => day.id === item.dayId);
  const session =
    item.target === 'review'
      ? state.reviewRecord?.session
      : item.session === 'review'
        ? day?.review
        : day?.learning;
  state.teaching.exposures.push({
    id: randomUUID(),
    target: item.target,
    ...(item.dayId ? { dayId: item.dayId } : {}),
    ...(item.recordId ? { recordId: item.recordId } : {}),
    ...(item.session ? { session: item.session } : {}),
    word: item.word,
    kind,
    source: 'ui',
    focusIds: [],
    beforeAttemptCount: session?.spellingAttempts.length ?? 0,
    at,
  });
  expose(state, item.word, at);
}
function currentContext(
  state: MiniSnapshot,
  action: Extract<
    MiniAction,
    {
      type:
        | 'record_card_view'
        | 'open_dictation'
        | 'clear_judgment'
        | 'unmark_studied'
        | 'advance_learning_card';
    }
  >,
) {
  if (action.target === 'review') {
    const record = state.reviewRecord;
    requireFact(
      record &&
        record.id.toLowerCase() === action.recordId?.toLowerCase() &&
        !record.paused &&
        record.session.phase !== 'finished',
      '当前复习卡片已变化。',
    );
    requireFact(
      action.session === undefined || action.session === 'review',
      '当前复习阶段已变化。',
    );
    return { record, session: record.session, word: record.session.queue[0], day: undefined };
  }
  const day = state.ledger.days.find(
    (day) => day.id === action.dayId && day.id === state.planning.activeDayId,
  );
  requireFact(day && !day.paused && day.phase !== 'finished', '当前学习组已暂停或变化。');
  requireFact(action.session === undefined || action.session === day.phase, '当前学习阶段已变化。');
  const session = day.phase === 'review' ? day.review : day.learning;
  const word =
    day.phase === 'review'
      ? (currentMiniWindow(day)?.visit?.word ?? session?.queue[0])
      : currentLearningWord(day);
  return { day, session, word, record: undefined };
}
export function applyMiniMeasurementAction(
  state: MiniSnapshot,
  action: MiniAction,
  at: number,
  receivedAt: number,
): boolean {
  const active = activeMiniProbe(state);
  if (action.type === 'hide_card') {
    closeVisible(state, at, action.word);
    return true;
  }
  if (
    active &&
    [
      'choose_judgment',
      'advance_judgment',
      'submit_spelling',
      'mark_studied',
      'complete_review',
      'complete_learning',
      'submit_translation',
      'advance_translation',
      'begin',
      'memory_advance',
      'memory_reveal',
      'memory_undo',
      'window_choose',
      'window_correct',
      'window_advance',
      'window_draft',
    ].includes(action.type)
  )
    requireFact(false, '请先结束独立检验，再继续其他学习任务。');
  if (
    action.type === 'record_card_view' &&
    ((action.target === 'daily' && action.dayId === undefined) || active)
  ) {
    showVisible(state, action.word, receivedAt);
    const card = miniMemory(state, action.word);
    if (card) expose(state, action.word, receivedAt);
    if (
      active &&
      action.word.spelling.trim().toLowerCase() === active.word.spelling.trim().toLowerCase()
    ) {
      if (active.submittedAt === undefined) {
        active.helpAt ??= receivedAt;
        if (!active.helpSources.includes('ui')) active.helpSources.push('ui');
      }
      expose(state, active.word, receivedAt);
    }
    return true;
  }
  if (action.type === 'begin_probe') {
    requireFact(!activeMiniProbe(state), '请先结束当前独立检验。');
    requireFact(action.word.meaning.trim(), '独立拼写检验需要明确的中文释义。');
    closePractice(state, at);
    closeVisible(state, receivedAt);
    const previouslyKnown =
      state.ledger.days.some((day) =>
        [...day.reviewWords, ...day.learningWords].some(
          (word) => wordKey(word) === wordKey(action.word),
        ),
      ) ||
      [state.reviewRecord, ...state.reviewHistory].some((record) =>
        record?.session.words.some((word) => wordKey(word) === wordKey(action.word)),
      );
    const card = introduce(state, action.word, at, !previouslyKnown);
    for (const view of state.scheduling.views)
      if (view.word.spelling.trim().toLowerCase() === action.word.spelling.trim().toLowerCase())
        expose(state, action.word, view.at);
    const probe: MiniProbe = {
      id: randomUUID(),
      word: action.word,
      openedAt: receivedAt,
      exposureCountAtOpen: state.teaching.exposures.length,
      status: 'active',
      exposureKnown: card.exposureKnown,
      lastAnswerExposureAt: card.lastAnswerExposureAt,
      helpSources: [],
    };
    state.scheduling.probes.push(probe);
    state.scheduling.activeProbeId = probe.id;
    return true;
  }
  if (
    action.type === 'submit_probe' ||
    action.type === 'reveal_probe' ||
    action.type === 'end_probe' ||
    action.type === 'record_probe_help'
  ) {
    const probe = activeMiniProbe(state);
    requireFact(probe && probe.id === action.probeId, '当前独立检验已变化。');
    if (action.type === 'end_probe') {
      closeVisible(state, receivedAt, probe.word);
      probe.endedAt = receivedAt;
      probe.status = 'ended';
      state.scheduling.activeProbeId = null;
      return true;
    }
    if (action.type === 'record_probe_help') {
      if (probe.submittedAt === undefined) {
        probe.helpAt ??= receivedAt;
        if (!probe.helpSources.includes(action.source)) probe.helpSources.push(action.source);
      }
      expose(state, probe.word, receivedAt);
      showVisible(state, probe.word, receivedAt);
      return true;
    }
    if (action.type === 'reveal_probe') {
      probe.revealedAt ??= receivedAt;
      expose(state, probe.word, receivedAt);
      showVisible(state, probe.word, receivedAt);
      return true;
    }
    requireFact(
      probe.answer === undefined &&
        action.answer.trim() &&
        at >= probe.openedAt &&
        at <= receivedAt,
      '本题已提交，或作答时间无效。',
    );
    const card = miniMemory(state, probe.word);
    requireFact(card, '独立检验的目标缺失。');
    const helped =
      probe.helpAt !== undefined ||
      probe.revealedAt !== undefined ||
      state.teaching.exposures
        .slice(probe.exposureCountAtOpen)
        .some(
          (item) => sameWord(item.word, probe.word) && item.at >= probe.openedAt && item.at <= at,
        );
    const last = card.lastAnswerExposureAt;
    const intervening =
      last !== null &&
      state.scheduling.cards.some(
        (other) =>
          other.senseId !== card.senseId &&
          other.lastServedAt !== null &&
          other.lastServedAt > last &&
          other.lastServedAt <= at,
      );
    const correct = action.answer.trim().toLowerCase() === probe.word.spelling.trim().toLowerCase();
    const result = classifyMeasurement(
      {
        eventId: probe.id,
        targetId: card.senseId,
        ability: 'spelling',
        kind: 'attempt',
        occurredAt: dateAt(at).toISOString(),
        answerProvided: true,
        outcome: correct ? 'correct' : 'incorrect',
        assessment: 'objective',
        help: helped ? 'present' : 'none',
        ...(card.exposureKnown
          ? { lastAnswerExposureAt: last === null ? null : dateAt(last).toISOString() }
          : {}),
        interveningOtherTarget: intervening,
      },
      dateAt(receivedAt).toISOString(),
    );
    probe.answer = action.answer;
    probe.correct = correct;
    probe.submittedAt = at;
    probe.status = 'answered';
    probe.classification = result.classification;
    probe.reason = result.reason;
    probe.measurement = {
      ...defaultMeasurementRules,
      help: helped ? 'present' : 'none',
      interveningOtherTarget: intervening,
      lastAnswerExposureAt: last,
    };
    if (
      result.classification === 'independent_success' ||
      result.classification === 'independent_failure'
    ) {
      requireFact(
        card.fsrs?.last_review === undefined || at > card.fsrs.last_review,
        '不能把迟到检验写到较新排期之前。',
      );
      const rating = result.classification === 'independent_success' ? Rating.Good : Rating.Again;
      const next = scheduler.next(
        card.fsrs ? hydrated(card.fsrs) : createEmptyCard(dateAt(at)),
        dateAt(at),
        rating,
      ).card;
      probe.scheduleBefore = card.fsrs;
      const saved = serialized(next);
      card.fsrs = saved;
      card.dueAt = saved.due;
      card.state =
        next.state === State.Learning
          ? 'learning'
          : next.state === State.Review
            ? 'review'
            : 'relearning';
      probe.scheduleAfter = saved;
      probe.schedulerVersion = 'ts-fsrs@5.4.2/FSRS-6';
      probe.parameters = structuredClone(state.scheduling.parameters);
      probe.rating = rating === Rating.Good ? 'Good' : 'Again';
      probe.dueAt = card.dueAt;
      if (rating === Rating.Good && (card.practicePriority ?? 0) > 0) {
        card.practicePriority = Math.max(0, (card.practicePriority ?? 0) - 1);
        card.priorityUpdatedAt = at;
        if (card.practicePriority === 0) delete card.nextProbeAt;
      }
    }
    serve(state, probe.word, at);
    // Objective feedback displays the reference only after the immutable first answer.
    probe.revealedAt ??= receivedAt;
    expose(state, probe.word, receivedAt);
    showVisible(state, probe.word, receivedAt);
    return true;
  }
  if (
    action.type === 'record_card_view' ||
    action.type === 'open_dictation' ||
    action.type === 'clear_judgment' ||
    action.type === 'unmark_studied' ||
    action.type === 'advance_learning_card'
  ) {
    requireFact(!activeMiniProbe(state), '请先结束独立检验，再查看词卡或继续学习。');
    const context = currentContext(state, action);
    if (action.type === 'unmark_studied') {
      const day = context.day,
        last = day?.studiedWords.at(-1);
      requireFact(
        day?.phase === 'learning' &&
          last &&
          sameWord(last.word, action.word) &&
          day.learning?.spellingAttempts.length === 0,
        '只能撤销尚未开始总拼写的最近记住标记。',
      );
      day.studiedWords.pop();
      (day.studyMarkEvents ??= []).push({ word: action.word, remembered: false, at });
      delete day.retainedLearningWord;
      closePractice(state, at);
      return true;
    }
    if (action.type === 'advance_learning_card') {
      requireFact(
        context.day?.phase === 'learning' &&
          sameWord(context.day.retainedLearningWord, action.word),
        '当前留词卡片已变化。',
      );
      closeVisible(state, receivedAt, action.word);
      delete context.day.retainedLearningWord;
      closePractice(state, at);
      return true;
    }
    const windowVisit = context.day ? currentMiniWindow(context.day)?.visit : undefined;
    if (action.type === 'open_dictation' && windowVisit) {
      requireFact(
        sameWord(windowVisit.word, action.word) &&
          (windowVisit.stage === 0 || windowVisit.revealedAt !== undefined),
        '请先展开当前词卡，再开启草稿拼写。',
      );
    } else if (action.type === 'open_dictation' && context.day?.memory) {
      requireFact(
        sameWord(context.word, action.word) &&
          (context.day.memory.round === 1 || context.day.memory.revealed),
        '请先展开当前词卡，再开启草稿拼写。',
      );
    } else if (action.type === 'open_dictation' && context.day?.phase === 'learning') {
      requireFact(
        sameWord(context.day.studiedWords.at(-1)?.word, action.word) &&
          context.day.learning?.spellingAttempts.length === 0,
        '请先记住当前新词，再主动开启单卡默写。',
      );
    } else requireFact(sameWord(context.word, action.word), '当前目标词已变化。');
    if (action.type === 'clear_judgment') {
      const session = context.session,
        event = session?.judgmentEvents.at(-1);
      requireFact(
        session?.phase === 'judgment' && event && event.final === undefined,
        '当前没有可撤销的自评。',
      );
      session.judgmentEvents.pop();
      (session.clearedJudgments ??= []).push({ ...event, clearedAt: at });
      closePractice(state, at);
      return true;
    }
    if (action.type === 'record_card_view') {
      showVisible(state, action.word, receivedAt);
      expose(state, action.word, receivedAt);
      state.teaching.exposures.push({
        id: randomUUID(),
        target: action.target,
        ...(context.day
          ? {
              dayId: context.day.id,
              session: context.day.phase === 'review' ? 'review' : 'learning',
            }
          : { recordId: context.record?.id, session: 'review' }),
        word: action.word,
        kind: 'potentialHelp',
        source: 'ui',
        focusIds: [],
        beforeAttemptCount: context.session?.spellingAttempts.length ?? 0,
        at: receivedAt,
      });
      return true;
    }
    requireFact(
      windowVisit !== undefined ||
        context.day?.phase === 'learning' ||
        (context.session?.phase === 'judgment' &&
          context.session.judgmentEvents.at(-1)?.final === undefined &&
          context.session.judgmentEvents.length > 0),
      '请先完成当前卡片的自评。',
    );
    closePractice(state, at);
    closeVisible(state, receivedAt);
    const item = {
      id: randomUUID(),
      target: action.target,
      ...(action.dayId ? { dayId: action.dayId } : {}),
      ...(action.recordId ? { recordId: action.recordId.toLowerCase() } : {}),
      session: action.session ?? (context.day?.phase === 'learning' ? 'learning' : 'review'),
      word: action.word,
      openedAt: receivedAt,
      attempts: [],
    };
    state.practice.dictations.push(item);
    state.practice.activeDictationId = item.id;
    return true;
  }
  if (
    action.type === 'submit_dictation' ||
    action.type === 'reveal_dictation' ||
    action.type === 'close_dictation'
  ) {
    const item = state.practice.dictations.find(
      (item) => item.id === state.practice.activeDictationId && item.id === action.dictationId,
    );
    requireFact(
      item &&
        item.closedAt === undefined &&
        item.target === action.target &&
        item.dayId === action.dayId &&
        item.recordId === action.recordId?.toLowerCase(),
      '当前单卡默写已变化。',
    );
    requireFact(
      action.session === undefined || action.session === item.session,
      '单卡默写对应阶段已变化。',
    );
    if (action.type === 'close_dictation') {
      closePractice(state, at);
      return true;
    }
    if (action.type === 'reveal_dictation') {
      if (item.revealedAt === undefined) {
        item.revealedAt = receivedAt;
        dictationExposure(state, item, receivedAt, 'answerReveal');
        showVisible(state, item.word, receivedAt);
      }
      return true;
    }
    requireFact(at >= item.openedAt && at <= receivedAt, '单卡默写作答时间无效。');
    item.attempts.push({
      id: randomUUID(),
      answer: action.answer,
      correct: action.answer.trim().toLowerCase() === item.word.spelling.trim().toLowerCase(),
      submittedAt: at,
    });
    item.revealedAt ??= receivedAt;
    dictationExposure(state, item, receivedAt, 'answerReveal');
    showVisible(state, item.word, receivedAt);
    serve(state, item.word, at);
    return true;
  }
  return false;
}

export function observeMiniLearningCommand(state: MiniSnapshot, action: MiniAction, at: number) {
  if (action.type === 'memory_undo') closeVisible(state, at);
  if (
    action.type === 'memory_advance' ||
    action.type === 'window_advance' ||
    action.type === 'advance_judgment' ||
    action.type === 'submit_spelling' ||
    (action.type === 'mark_studied' && !action.remainOnCard)
  )
    closeVisible(state, at, action.word);
  if (action.type === 'memory_advance' || action.type === 'memory_reveal') {
    expose(state, action.word, at);
    if (action.type === 'memory_advance') serve(state, action.word, at);
  }
  if (action.type === 'window_advance') {
    expose(state, action.word, at);
    serve(state, action.word, at);
  }
  if (action.type === 'window_choose' || action.type === 'window_correct')
    expose(state, action.word, at);
  if (action.type === 'mark_studied') {
    const day = state.ledger.days.find((day) => day.id === action.dayId);
    if (day) {
      (day.studyMarkEvents ??= []).push({ word: action.word, remembered: true, at });
      if (action.remainOnCard) day.retainedLearningWord = action.word;
    }
    expose(state, action.word, at);
    serve(state, action.word, at);
  }
  if (action.type === 'record_exposure') expose(state, action.word, at);
  if (action.type === 'choose_judgment') expose(state, action.word, at);
  if (action.type === 'submit_spelling') {
    serve(state, action.word, at);
    const day =
      action.target === 'daily'
        ? state.ledger.days.find((day) => day.id === action.dayId)
        : undefined;
    const session = day
      ? action.session === 'review'
        ? day.review
        : day.learning
      : state.reviewRecord?.session;
    const last = session?.spellingAttempts.at(-1);
    if (
      session?.spellingPolicy === 'retry-errors-v1' &&
      session.spellingSkips?.some((skip) => sameWord(skip.word, action.word) && skip.at === at)
    ) {
      prioritizePractice(state, action.word, at);
    }
    if (last?.revealedAnswerAt !== undefined) expose(state, action.word, last.revealedAnswerAt);
    if (day) delete day.retainedLearningWord;
  }
  if (
    [
      'begin',
      'advance_judgment',
      'memory_advance',
      'memory_undo',
      'window_choose',
      'window_correct',
      'window_advance',
      'mark_studied',
      'submit_spelling',
      'complete_review',
      'complete_learning',
      'pause',
      'end_session',
    ].includes(action.type)
  )
    closePractice(state, at);
  if (
    action.target === 'daily' &&
    [
      'begin',
      'window_choose',
      'window_correct',
      'window_advance',
      'advance_judgment',
      'complete_review',
      'advance_translation',
      'pause',
      'end_session',
    ].includes(action.type)
  ) {
    const day = state.ledger.days.find((day) => day.id === state.planning.activeDayId);
    if (day?.flow) {
      const visit = currentMiniWindow(day)?.visit;
      if (
        !day.paused &&
        visit &&
        (visit.stage !== 1 ||
          visit.initial !== undefined ||
          day.sentences.some((sentence) => sameWord(sentence.word, visit.word)))
      ) {
        showVisible(state, visit.word, at);
        expose(state, visit.word, at);
      } else closeVisible(state, at);
    }
  }
}
export function validateMiniScheduling(state: MiniSnapshot) {
  requireFact(
    new Set(state.scheduling.cards.map((card) => card.senseId)).size ===
      state.scheduling.cards.length,
    '记忆对象身份重复。',
  );
  requireFact(
    state.scheduling.parameters.weights.length === 21 &&
      state.scheduling.parameters.weights.every((value, index) => value === parameters.w[index]),
    '记忆模型参数与固定版本不一致。',
  );
  for (const card of state.scheduling.cards) {
    requireFact(
      card.nextProbeAt === undefined ||
        ((card.practicePriority ?? 0) > 0 && card.priorityUpdatedAt !== undefined),
      '额外拼写练习提醒须关联已记录的困难词优先级。',
    );
    requireFact(
      card.senseId === senseId(card.word) && (card.fsrs === null || card.fsrs.reps > 0),
      '记忆对象或有效复习次数无效。',
    );
    const ratings = state.scheduling.probes.filter(
      (probe) => senseId(probe.word) === card.senseId && probe.rating !== undefined,
    );
    requireFact(
      card.fsrs === null
        ? ratings.length === 0
        : card.fsrs.reps === ratings.length &&
            card.dueAt === card.fsrs.due &&
            JSON.stringify(card.fsrs) === JSON.stringify(ratings.at(-1)?.scheduleAfter),
      '记忆排期必须来自已保存且仅结算一次的独立检验。',
    );
  }
  for (const day of state.ledger.days)
    requireFact(
      day.retainedLearningWord === undefined ||
        (day.phase === 'learning' &&
          sameWord(day.retainedLearningWord, day.studiedWords.at(-1)?.word) &&
          day.learning?.spellingAttempts.length === 0),
      '留词卡片必须对应尚未开始总拼写的最近记住记录。',
    );
  requireFact(
    state.scheduling.activeProbeId === null ||
      state.scheduling.probes.some(
        (probe) => probe.id === state.scheduling.activeProbeId && probe.status !== 'ended',
      ),
    '独立检验身份无效。',
  );
  for (const probe of state.scheduling.probes) {
    requireFact(
      (probe.answer === undefined) === (probe.submittedAt === undefined),
      '独立检验原答不完整。',
    );
    requireFact(
      probe.rating === undefined ||
        ((probe.classification === 'independent_success' ||
          probe.classification === 'independent_failure') &&
          probe.scheduleAfter !== undefined),
      '受支持练习不能写入 FSRS 评分。',
    );
    requireFact(
      probe.rating === undefined ||
        (probe.rating === 'Good') === (probe.classification === 'independent_success'),
      '独立检验评分与原始客观结果不一致。',
    );
  }
}

export function miniRetrievability(card: MiniMemoryCard, at: number): number | null {
  return card.fsrs ? scheduler.get_retrievability(hydrated(card.fsrs), dateAt(at), false) : null;
}

export function orderMiniDue<T extends { word: MiniWord; schedule: { dueAt: number } }>(
  entries: T[],
  state: MiniSnapshot['scheduling'],
  at: number,
): T[] {
  const remaining = [...entries],
    result: T[] = [];
  const memory = (item: T) => state.cards.find((card) => card.senseId === senseId(item.word));
  const waiting = (item: T) =>
    Math.max(item.schedule.dueAt, memory(item)?.lastServedAt ?? -Infinity);
  const recall = (item: T) => {
    const card = memory(item);
    return card ? miniRetrievability(card, at) : null;
  };
  while (remaining.length) {
    const fairness = (state.servedCount + result.length) % 5 === 4;
    const ordered = [...remaining].sort(
      (a, b) =>
        (fairness ? 0 : (memory(b)?.practicePriority ?? 0) - (memory(a)?.practicePriority ?? 0)) ||
        (fairness ? waiting(a) - waiting(b) : (recall(a) ?? Infinity) - (recall(b) ?? Infinity)) ||
        waiting(a) - waiting(b) ||
        wordKey(a.word).localeCompare(wordKey(b.word)),
    );
    const selected = ordered[0];
    if (!selected) break;
    result.push(selected);
    remaining.splice(remaining.indexOf(selected), 1);
  }
  return result;
}
