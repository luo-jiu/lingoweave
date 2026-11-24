import { randomUUID } from 'node:crypto';
import type {
  MiniAction,
  MiniDay,
  MiniPlanContext,
  MiniPlanLimits,
  MiniPlanPreviewInput,
  MiniPlanSession,
  MiniSnapshot,
  MiniWord,
} from '@lingoweave/contracts';
import { LearningError } from './learning-store.js';
import { resizeMiniReview } from './mini-review-groups.js';
import {
  advancesCorrectSpelling,
  applyMiniAction,
  currentLearningWord,
  currentMiniWindow,
  currentTranslation,
  historicalDeck,
  isMiniDayOnDate,
  outstandingReviews,
  localDay,
  miniCandidates,
  sameWord,
  startMiniMemoryRounds,
  resumeMiniFlow,
  wordKey,
} from './mini-study.js';

const appleEpoch = 978_307_200;
const recoveryAfterDays = 3;
const recoveryWordLimit = 3;
function dateAt(at: number) {
  return new Date((at + appleEpoch) * 1000);
}
function spellingKey(word: MiniWord) {
  return word.spelling.trim().toLowerCase();
}
function lastWhere<T>(values: T[], predicate: (value: T) => boolean): T | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined && predicate(value)) return value;
  }
  return undefined;
}
function pendingMiniDay(state: MiniSnapshot, date: string) {
  const selected = state.ledger.days.find(
    (day) =>
      day.id === state.planning.activeDayId &&
      day.phase !== 'finished' &&
      isMiniDayOnDate(day, date),
  );
  if (selected) return selected;
  return lastWhere(
    state.ledger.days,
    (day) => day.phase !== 'finished' && isMiniDayOnDate(day, date),
  );
}
export function currentMiniPlanSession(state: MiniSnapshot) {
  return lastWhere(state.planning.sessions, (session) => session.endedAt === undefined);
}
function planError(message: string): never {
  throw new LearningError('MINI_PLAN_CONFLICT', message);
}
function basePlan(state: MiniSnapshot, timezone: string, at: number) {
  const date = localDay(dateAt(at), timezone);
  const todayOverride =
    lastWhere(
      state.planning.dailyOverrides,
      (plan) => plan.date === date && plan.timezone === timezone,
    ) ?? null;
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay() || 7;
  const longTerm = state.planning.longTerm;
  return {
    date,
    todayOverride,
    mode: todayOverride?.mode ?? (longTerm.weekdays.includes(weekday) ? 'normal' : 'rest'),
    wordLimit: todayOverride?.wordLimit ?? longTerm.wordLimit,
    newWordLimit: todayOverride?.newWordLimit ?? longTerm.newWordLimit,

    dailyNewGoal: todayOverride?.dailyNewGoal ?? longTerm.dailyNewGoal ?? longTerm.newWordLimit,
    groupSize: todayOverride?.groupSize ?? longTerm.groupSize ?? 20,
  };
}
export function miniCompletedToday(state: MiniSnapshot, timezone: string, at: number) {
  const date = localDay(dateAt(at), timezone);
  return new Set(
    state.ledger.days.flatMap((day) =>
      (day.flow?.completed ?? [])
        .filter((item) => localDay(dateAt(item.at), timezone) === date)
        .map((item) => wordKey(item.word)),
    ),
  ).size;
}
function limitsForStart(state: MiniSnapshot, timezone: string, at: number): MiniPlanLimits {
  const base = basePlan(state, timezone, at);
  const override = state.planning.nextSessionOverride;
  return {
    wordLimit: override?.wordLimit ?? base.wordLimit,
    newWordLimit: base.mode === 'reviewOnly' ? 0 : (override?.newWordLimit ?? base.newWordLimit),
  };
}
function modeAllows(state: MiniSnapshot, day: MiniDay, timezone: string, at: number) {
  const base = basePlan(state, timezone, at);
  const active = currentMiniPlanSession(state);
  const temporaryRestException =
    active?.dayId === day.id &&
    active.overrideRest === true &&
    localDay(dateAt(active.startedAt), active.timezone) === base.date;
  if (day.phase === 'review' && active?.dayId === day.id && active.intent === 'review') return true;
  if (base.mode === 'rest' && day.flow?.extraGroupTarget !== undefined) return true;
  if (base.mode === 'rest' && !temporaryRestException) return false;
  return base.mode !== 'reviewOnly' || day.phase === 'review';
}
function recommendedDay(state: MiniSnapshot, timezone: string, at: number) {
  const date = localDay(dateAt(at), timezone);
  const selected = state.ledger.days.find(
    (day) =>
      day.id === state.planning.activeDayId &&
      day.phase !== 'finished' &&
      isMiniDayOnDate(day, date) &&
      modeAllows(state, day, timezone, at),
  );
  return (
    selected ??
    lastWhere(
      state.ledger.days,
      (day) =>
        day.phase !== 'finished' &&
        isMiniDayOnDate(day, date) &&
        modeAllows(state, day, timezone, at),
    )
  );
}
export function lastMiniActivity(state: MiniSnapshot): number | null {
  const times: number[] = [];
  const addReview = (session: MiniDay['review']) => {
    if (!session) return;
    for (const event of session.judgmentEvents) {
      times.push(event.selectedAt);
      if (event.finalizedAt !== undefined) times.push(event.finalizedAt);
    }
    for (const attempt of session.spellingAttempts) times.push(attempt.submittedAt);
  };
  for (const day of state.ledger.days) {
    addReview(day.review);
    addReview(day.learning);
    for (const group of day.flow?.groups ?? []) addReview(group.spelling);
    for (const event of [
      ...(day.flow?.window.events ?? []),
      ...(day.review?.relearning?.events ?? []),
    ])
      times.push(event.confirmedAt);
    for (const exposure of day.studiedWords) times.push(exposure.at);
    for (const attempt of day.translation) times.push(attempt.submittedAt);
  }
  addReview(state.reviewRecord?.session);
  for (const record of state.reviewHistory) addReview(record.session);
  for (const probe of state.scheduling.probes)
    if (probe.submittedAt !== undefined) times.push(probe.submittedAt);
  for (const item of state.practice.dictations)
    for (const attempt of item.attempts) times.push(attempt.submittedAt);
  return times.length > 0 ? times.reduce((a, b) => Math.max(a, b)) : null;
}
export function miniPlanContext(
  state: MiniSnapshot,
  input: MiniPlanPreviewInput,
  at: number,
): MiniPlanContext {
  const base = basePlan(state, input.timezone, at);
  const active = currentMiniPlanSession(state);
  const next = limitsForStart(state, input.timezone, at);
  const limits =
    active && localDay(dateAt(active.startedAt), active.timezone) === base.date ? active : next;
  const { candidates, schedules } = miniCandidates(
    state.ledger,
    input.deck,
    at,
    state.scheduling,
    base.date,
  );
  const lastActivityAt = lastMiniActivity(state);
  const completedNewCount = miniCompletedToday(state, input.timezone, at);
  const remainingNewCount = Math.max(0, base.dailyNewGoal - completedNewCount);
  const dueWords = outstandingReviews(state, at, base.date, input.deck);
  const absenceDays =
    lastActivityAt === null
      ? 0
      : Math.max(
          0,
          Math.round(
            (Date.parse(`${base.date}T00:00:00.000Z`) -
              Date.parse(`${localDay(dateAt(lastActivityAt), input.timezone)}T00:00:00.000Z`)) /
              86_400_000,
          ),
        );
  const recommended = recommendedDay(state, input.timezone, at);
  const completedTail = (day: MiniDay) =>
    day.phase === 'learning' && day.flow?.goalReached === true && remainingNewCount === 0;
  const pending =
    recommended && completedTail(recommended) && dueWords.size === 0 ? undefined : recommended;
  const pendingGroups = state.ledger.days.flatMap((day) =>
    !isMiniDayOnDate(day, base.date) ||
    day.phase === 'finished' ||
    (base.mode === 'normal' && completedTail(day) && dueWords.size === 0)
      ? []
      : [
          {
            dayId: day.id,
            phase: day.phase,
            paused: day.paused,
            startedAt: day.startedAt,
            canContinue: modeAllows(state, day, input.timezone, at),
            blockedReason: modeAllows(state, day, input.timezone, at)
              ? null
              : base.mode === 'rest'
                ? '今天已休息，原进度保留。'
                : '今天只复习，这组的新词或写作进度保留。',
          },
        ],
  );
  const hasNewWords = candidates.some((word) => !schedules.has(wordKey(word)));
  const hasCandidates =
    dueWords.size > 0 || (base.mode === 'normal' && remainingNewCount > 0 && hasNewWords);
  const finishedReviewToday = state.ledger.days.some(
    (day) =>
      day.reviewWords.length > 0 &&
      day.reviewFinishedAt !== undefined &&
      localDay(dateAt(day.reviewFinishedAt), input.timezone) === base.date,
  );
  const todayCompleted =
    base.mode !== 'rest' &&
    !pending &&
    !hasCandidates &&
    (completedNewCount > 0 || finishedReviewToday);
  const learningDay = lastWhere(
    state.ledger.days,
    (day) =>
      isMiniDayOnDate(day, base.date) && day.phase !== 'finished' && day.writingRequired !== false,
  );
  const tail = learningDay?.flow;
  const availableNewWords = new Set(
    [
      ...candidates.filter((word) => !schedules.has(wordKey(word))),
      ...(tail?.window.members.map((member) => member.word) ?? []),
      ...(tail?.groupWords ?? []),
      ...(tail?.candidates.slice(tail.candidateIndex) ?? []),
    ].map(wordKey),
  ).size;
  const hasLearning =
    availableNewWords > 0 ||
    (!!learningDay &&
      !tail &&
      (learningDay.phase === 'translation' || learningDay.learningWords.length > 0));
  // The review group may be active while its learning group waits. Once spelling
  // starts, groupWords fixes the capacity across every translation confirmation.
  const activeExtraGroupWordCount =
    tail?.extraGroupTarget !== undefined
      ? learningDay?.learning
        ? tail.groupWords.length
        : Math.max(tail.groupWords.length, tail.extraGroupTarget - completedNewCount)
      : undefined;
  const extraInProgress = activeExtraGroupWordCount !== undefined;
  const canStartLearning =
    base.mode === 'normal'
      ? hasLearning && (remainingNewCount > 0 || extraInProgress)
      : base.mode === 'rest' && extraInProgress;
  const extraGroupWordCount =
    !extraInProgress && ((todayCompleted && base.mode === 'normal') || base.mode === 'rest')
      ? Math.min(base.groupSize, availableNewWords)
      : 0;
  let blockedReason: string | null = null;
  if (todayCompleted) blockedReason = '今日任务已完成。';
  else if (base.mode === 'rest' && !pending)
    blockedReason = base.todayOverride
      ? '今天已设为休息，进度会保留。'
      : '今天是计划休息日，进度会保留。';
  else if (base.mode === 'reviewOnly' && !pending && pendingGroups.length > 0 && !hasCandidates)
    blockedReason = '今天只复习，上次的新词或写作进度已保留；改为正常学习后可继续。';
  else if (!pending && !hasCandidates)
    blockedReason = base.mode === 'reviewOnly' ? '当前没有到期复习词。' : '当前没有可开始的任务。';
  return {
    date: base.date,
    timezone: input.timezone,
    effective: {
      mode: base.mode,
      wordLimit: limits.wordLimit,
      newWordLimit: base.mode === 'reviewOnly' ? 0 : limits.newWordLimit,

      dailyNewGoal: base.dailyNewGoal,
      groupSize: base.groupSize,
    },
    completedNewCount,
    remainingNewCount,
    todayCompleted,
    canStartReview: dueWords.size > 0,
    canStartLearning,
    canStartExtraGroup: extraGroupWordCount > 0,
    extraGroupWordCount,
    ...(activeExtraGroupWordCount !== undefined && { activeExtraGroupWordCount }),
    hasDueReviews: dueWords.size > 0,
    todayOverride: base.todayOverride,
    dueCount: dueWords.size,
    newCount: new Set(candidates.filter((word) => !schedules.has(wordKey(word))).map(spellingKey))
      .size,
    lastActivityAt,
    absenceDays,
    recoverySuggested: absenceDays >= recoveryAfterDays && (pending !== undefined || hasCandidates),
    recoveryWordLimit: Math.min(next.wordLimit, recoveryWordLimit),
    pendingDayId: pending?.id ?? null,
    pendingGroups,
    canStart: !pending && base.mode !== 'rest' && hasCandidates,
    canContinue: !!pending,
    blockedReason,
  };
}
function pauseDay(day: MiniDay, at: number) {
  if (day.phase !== 'finished' && !day.paused) {
    day.paused = true;
    (day.pauseEvents ??= []).push({ paused: true, at });
  }
}
function finishSession(state: MiniSnapshot, at: number, reason: MiniPlanSession['pauseReason']) {
  const session = currentMiniPlanSession(state);
  if (session) {
    session.endedAt = at;
    session.pauseReason = reason;
  }
}
function pauseSession(
  state: MiniSnapshot,
  day: MiniDay,
  at: number,
  reason: MiniPlanSession['pauseReason'],
) {
  pauseDay(day, at);
  finishSession(state, at, reason);
}
function openSession(
  state: MiniSnapshot,
  day: MiniDay,
  timezone: string,
  at: number,
  limits: MiniPlanLimits,
  overrideRest = false,
  source: MiniPlanSession['source'] = 'default',
  intent?: MiniPlanSession['intent'],
) {
  finishSession(state, at, 'ended');
  state.planning.sessions.push({
    id: randomUUID(),
    dayId: day.id,
    timezone,
    startedAt: at,
    ...limits,
    servedWords: [],
    newWords: [],
    source,
    ...(intent && { intent }),
    ...(overrideRest ? { overrideRest: true } : {}),
  });
  if (intent !== 'review') state.planning.nextSessionOverride = null;
  if (day.paused) {
    day.paused = false;
    (day.pauseEvents ??= []).push({ paused: false, at });
  }
}

export function resumeMiniTimePause(
  state: MiniSnapshot,
  expiredSessions: Set<string>,
  timezone: string,
  at: number,
): boolean {
  const day = state.ledger.days.find((item) => item.id === state.planning.activeDayId);
  const last = lastWhere(state.planning.sessions, (session) => session.dayId === day?.id);
  if (
    !day?.flow ||
    !day.paused ||
    day.phase === 'finished' ||
    day.flow.goalReached ||
    !last ||
    !expiredSessions.has(last.id) ||
    currentMiniPlanSession(state) ||
    day.pauseEvents?.at(-1)?.at !== last.endedAt
  )
    return false;
  const context = miniPlanContext(state, { deck: [], timezone }, at);
  if (
    !context.pendingGroups.find((group) => group.dayId === day.id)?.canContinue ||
    (day.phase !== 'review' && context.hasDueReviews)
  )
    return false;
  openSession(state, day, timezone, at, limitsForStart(state, timezone, at));
  return true;
}
function isSafeBoundary(day: MiniDay) {
  if (
    day.flow?.window.visit?.initial !== undefined ||
    day.review?.relearning?.visit?.initial !== undefined
  )
    return false;
  const session =
    day.phase === 'review' ? day.review : day.phase === 'learning' ? day.learning : undefined;
  if (session?.phase === 'judgment')
    return (
      session.judgmentEvents.at(-1)?.final !== undefined || session.judgmentEvents.length === 0
    );
  return !session || session.spellingState === 'awaitingFirst' || session.phase === 'finished';
}
function nextTarget(day: MiniDay): MiniWord | undefined {
  if (day.phase === 'review') {
    if (day.review?.phase !== 'finished')
      return currentMiniWindow(day)?.visit?.word ?? day.review?.queue[0];
    if (day.learningWords.length > 0) return day.learningWords[0];
    return day.writingRequired === false ? undefined : day.reviewWords[0];
  }
  if (day.phase === 'learning') {
    const word = currentLearningWord(day);
    if (word) return word;
    return [...day.reviewWords, ...day.learningWords][0];
  }
  return day.phase === 'translation' ? currentTranslation(day)?.sentence.word : undefined;
}
function refreshFlowPlan(state: MiniSnapshot, day: MiniDay, timezone: string, at: number) {
  if (!day.flow) return;
  const base = basePlan(state, timezone, at);
  resizeMiniReview(state, day, base.groupSize, at, base.date);
  if (day.writingRequired === false || !isSafeBoundary(day)) return;
  if (base.mode === 'rest') return;
  if (
    !isMiniDayOnDate(day, base.date) ||
    (day.flow.dailyNewGoal === base.dailyNewGoal && day.flow.groupSize === base.groupSize)
  )
    return;
  // Already assigned spelling/translation words are immutable; memory candidates may shrink.
  const paused = day.paused;
  resumeMiniFlow(
    day,
    {
      dailyNewGoal: base.dailyNewGoal,
      groupSize: base.groupSize,
      completedToday: miniCompletedToday(state, timezone, at),
    },
    at,
    timezone,
  );
  if (!day.flow.goalReached) day.paused = paused;
}
function enforceBudget(state: MiniSnapshot, day: MiniDay, at: number) {
  const session = currentMiniPlanSession(state);
  if (!session || session.dayId !== day.id) return;
  if (day.phase === 'finished') {
    finishSession(state, at, 'ended');
    return;
  }
  if (day.flow) {
    if (day.flow.goalReached && day.phase !== 'review') {
      pauseSession(state, day, at, 'budget');
      return;
    }
    return;
  }
  const next = nextTarget(day);
  const unseen =
    next && !session.servedWords.some((word) => spellingKey(word) === spellingKey(next));
  const newTarget =
    next &&
    day.learningWords.some((word) => sameWord(word, next)) &&
    !day.studiedWords.some((item) => spellingKey(item.word) === spellingKey(next)) &&
    !(session.newWords ?? []).some((word) => spellingKey(word) === spellingKey(next)) &&
    (day.memory === undefined || day.memory.round === 1);
  const atWordLimit = unseen && session.servedWords.length >= session.wordLimit;
  const atNewLimit = newTarget && (session.newWords?.length ?? 0) >= session.newWordLimit;
  if (isSafeBoundary(day) && (atWordLimit || atNewLimit)) pauseSession(state, day, at, 'budget');
}
function requireToday(date: string, timezone: string, at: number) {
  if (date !== localDay(dateAt(at), timezone))
    planError('今日调整的日期已过期，请刷新后重新设置。');
}
function blockedMode(
  state: MiniSnapshot,
  day: MiniDay,
  timezone: string,
  at: number,
  overrideRest = false,
) {
  const base = basePlan(state, timezone, at);
  const session = currentMiniPlanSession(state);
  if (day.phase === 'review' && session?.dayId === day.id && session.intent === 'review')
    return false;
  return (
    (base.mode === 'rest' && !overrideRest) ||
    (base.mode === 'reviewOnly' && day.phase !== 'review')
  );
}
export function applyMiniPlannedAction(
  state: MiniSnapshot,
  action: MiniAction,
  at: number,
  receivedAt: number,
  defaultTimezone: string,
  requestId?: string,
) {
  const background =
    action.type === 'add_sentences' ||
    action.type === 'record_feedback' ||
    action.type === 'qualitative_feedback' ||
    action.type === 'publish_writing' ||
    action.type === 'spelling_draft' ||
    action.type === 'memory_draft' ||
    action.type === 'window_draft' ||
    action.type === 'translation_draft';
  const previousSession = currentMiniPlanSession(state);
  if (
    !background &&
    previousSession &&
    localDay(dateAt(previousSession.startedAt), previousSession.timezone) !==
      localDay(dateAt(receivedAt), previousSession.timezone)
  )
    finishSession(state, receivedAt, 'ended');
  const timezone =
    'timezone' in action && action.timezone
      ? action.timezone
      : (previousSession?.timezone ?? defaultTimezone);
  const date = localDay(dateAt(receivedAt), timezone);
  const pending = pendingMiniDay(state, date);
  switch (action.type) {
    case 'set_long_term_plan':
      state.planning.longTerm = action.plan;
      if (pending) {
        refreshFlowPlan(
          state,
          pending,
          currentMiniPlanSession(state)?.timezone ?? pending.timezone ?? defaultTimezone,
          receivedAt,
        );
        enforceBudget(state, pending, receivedAt);
      }
      return;
    case 'set_today_plan': {
      requireToday(action.date, action.timezone, receivedAt);
      const plan = {
        date: action.date,
        timezone: action.timezone,
        mode: action.mode,
        wordLimit: action.wordLimit,
        newWordLimit: action.newWordLimit,

        ...(action.dailyNewGoal === undefined ? {} : { dailyNewGoal: action.dailyNewGoal }),
        ...(action.groupSize === undefined ? {} : { groupSize: action.groupSize }),
      };
      state.planning.dailyOverrides = state.planning.dailyOverrides.filter(
        (item) => item.date !== action.date || item.timezone !== action.timezone,
      );
      state.planning.dailyOverrides.push(plan);
      if (pending) refreshFlowPlan(state, pending, action.timezone, receivedAt);
      if (pending && blockedMode(state, pending, action.timezone, receivedAt))
        pauseSession(state, pending, receivedAt, 'rest');
      else if (pending) {
        const session = currentMiniPlanSession(state);
        if (session && session.source !== 'session')
          Object.assign(session, {
            wordLimit: action.wordLimit,
            newWordLimit: action.mode === 'reviewOnly' ? 0 : action.newWordLimit,

            source: 'today',
          });
        enforceBudget(state, pending, receivedAt);
      }
      return;
    }
    case 'clear_today_plan': {
      requireToday(action.date, action.timezone, receivedAt);
      state.planning.dailyOverrides = state.planning.dailyOverrides.filter(
        (item) => item.date !== action.date || item.timezone !== action.timezone,
      );
      if (pending) refreshFlowPlan(state, pending, action.timezone, receivedAt);
      const session = currentMiniPlanSession(state);
      if (session && session.source !== 'session') {
        const base = basePlan(state, action.timezone, receivedAt);
        Object.assign(session, {
          wordLimit: base.wordLimit,
          newWordLimit: base.newWordLimit,

          source: 'default',
        });
        if (pending) enforceBudget(state, pending, receivedAt);
      }
      return;
    }
    case 'set_session_plan': {
      const limits = {
        wordLimit: action.wordLimit,
        newWordLimit: action.newWordLimit,
      };
      const session = currentMiniPlanSession(state);
      if (session) {
        Object.assign(session, limits);
        session.source = 'session';
        if (pending) enforceBudget(state, pending, receivedAt);
      } else state.planning.nextSessionOverride = limits;
      return;
    }
    case 'clear_session_plan': {
      state.planning.nextSessionOverride = null;
      const session = currentMiniPlanSession(state);
      if (session) {
        const base = basePlan(state, session.timezone, receivedAt);
        session.wordLimit = base.wordLimit;
        session.newWordLimit = base.mode === 'reviewOnly' ? 0 : base.newWordLimit;
        session.source = base.todayOverride ? 'today' : 'default';
        if (pending) enforceBudget(state, pending, receivedAt);
      }
      return;
    }
    case 'end_session':
      if (!pending || action.target !== 'daily' || action.dayId !== pending.id)
        planError('没有可结束的本次学习。');
      pauseSession(state, pending, receivedAt, 'ended');
      return;
  }
  if (action.type === 'begin' && action.target === 'daily') {
    const base = basePlan(state, action.timezone, receivedAt);
    const completedToday = miniCompletedToday(state, action.timezone, receivedAt);
    const intent = action.intent;
    const preview =
      intent || action.extraGroupForDate !== undefined
        ? miniPlanContext(state, action, receivedAt)
        : undefined;
    if (intent === 'review' && !preview?.canStartReview) planError('当前没有到期复习词。');
    if (intent === 'learn' && !action.extraGroupForDate && !preview?.canStartLearning)
      planError('当前没有可开始的新词学习。');
    let extraGroupTarget: number | undefined;
    if (action.extraGroupForDate !== undefined) {
      requireToday(action.extraGroupForDate, action.timezone, receivedAt);
      if (!preview?.canStartExtraGroup || (base.mode === 'rest' && intent !== 'learn'))
        planError('当前不能开始加练，请刷新今日任务。');
      extraGroupTarget = completedToday + preview.extraGroupWordCount;
    }
    const extraBudget = extraGroupTarget === undefined ? {} : { extraGroupTarget };
    const active = currentMiniPlanSession(state);
    const continuedException =
      active?.overrideRest === true &&
      (!action.dayId || action.dayId === active.dayId) &&
      localDay(dateAt(active.startedAt), active.timezone) === base.date;
    const restPractice =
      base.mode === 'rest' &&
      intent === 'learn' &&
      (extraGroupTarget !== undefined || preview?.canStartLearning === true);
    if (
      base.mode === 'rest' &&
      intent !== 'review' &&
      !restPractice &&
      !action.overrideRest &&
      !continuedException
    )
      planError('今天已休息；如需学习，请明确选择临时学一次。');
    if (action.dayId) {
      const requested = state.ledger.days.find((day) => day.id === action.dayId);
      if (requested && !isMiniDayOnDate(requested, base.date))
        planError('已进入新的一天，请开始今天的学习。');
    }
    // Close the old run without inventing a completion or discarding any attempts.
    // This occurs in the same transaction as the successful begin, never in a plan preview.
    for (const day of state.ledger.days) {
      if (
        day.phase !== 'finished' &&
        day.archivedAt === undefined &&
        !isMiniDayOnDate(day, base.date)
      ) {
        pauseDay(day, receivedAt);
        day.archivedAt = receivedAt;
      }
    }
    const todayGroups = state.ledger.days.filter(
      (day) => isMiniDayOnDate(day, base.date) && day.phase !== 'finished',
    );
    const reviewGroup = todayGroups.find((day) => day.phase === 'review');
    const learningGroup = lastWhere(todayGroups, (day) => day.writingRequired !== false);
    let selected = action.newGroup
      ? undefined
      : action.dayId
        ? todayGroups.find((day) => day.id === action.dayId)
        : intent === 'review'
          ? reviewGroup
          : intent === 'learn'
            ? (learningGroup ?? reviewGroup)
            : base.mode === 'rest' && action.overrideRest
              ? pending
              : recommendedDay(state, action.timezone, receivedAt);
    if (action.dayId && !selected) planError('指定的学习组已完成或不存在，请刷新后重试。');
    if (intent === 'review' && selected && selected.phase !== 'review')
      planError('指定的学习组没有进行中的复习。');
    const v2 = action.flowVersion === 'sliding-window-v2' || selected?.flow !== undefined;
    const dueWords = outstandingReviews(state, receivedAt, base.date, action.deck);
    if (v2 && dueWords.size > 0 && selected?.phase !== 'review' && reviewGroup)
      selected = reviewGroup;
    const deferred = v2 && selected && selected.phase !== 'review' && dueWords.size > 0;
    if (deferred)
      selected = todayGroups.find(
        (day) => day.phase === 'review' && modeAllows(state, day, action.timezone, receivedAt),
      );
    if (selected)
      resizeMiniReview(state, selected, base.groupSize, receivedAt, base.date, action.deck);
    const existingFlow = todayGroups.some((day) => day.flow && day.id !== selected?.id);
    const reviewOnly =
      intent === 'review' ||
      base.mode === 'reviewOnly' ||
      (!!deferred && !selected) ||
      (v2 && dueWords.size > 0 && !selected && !!existingFlow);
    if (selected && base.mode === 'reviewOnly' && selected.phase !== 'review')
      planError('今天只复习，上次的新词或写作进度已保留；请先修改今日计划。');
    if (
      intent === 'learn' &&
      selected?.flow &&
      selected.writingRequired === false &&
      !learningGroup
    )
      delete selected.writingRequired;
    if (
      restPractice &&
      learningGroup?.flow &&
      learningGroup !== selected &&
      extraGroupTarget !== undefined
    ) {
      learningGroup.flow.extraGroupTarget = extraGroupTarget;
      learningGroup.flow.dailyNewGoal = 0;
    }
    if (selected?.flow && intent !== 'review') {
      const available = miniCandidates(
        state.ledger,
        action.deck,
        receivedAt,
        state.scheduling,
        base.date,
      );
      resumeMiniFlow(
        selected,
        {
          dailyNewGoal:
            selected.writingRequired === false ||
            restPractice ||
            (base.mode === 'rest' && selected.flow.extraGroupTarget !== undefined)
              ? 0
              : base.dailyNewGoal,
          groupSize: base.groupSize,
          completedToday,
          ...(selected.writingRequired === false ? {} : extraBudget),
        },
        receivedAt,
        action.timezone,
        selected.writingRequired === false
          ? []
          : available.candidates.filter((word) => !available.schedules.has(wordKey(word))),
      );
      if (selected.flow.goalReached && dueWords.size === 0)
        planError('今日新词目标已完成，进行中的词已保留。');
    } else if (selected && action.flowVersion === 'memory-rounds-v1')
      startMiniMemoryRounds(selected);
    if (
      selected &&
      active?.dayId === selected.id &&
      (!intent || active.intent === intent) &&
      !selected.paused &&
      !action.recovery &&
      (!state.planning.nextSessionOverride || intent === 'review')
    ) {
      state.planning.activeDayId = selected.id;
      enforceBudget(state, selected, receivedAt);
      return;
    }
    const limits =
      intent === 'review'
        ? { wordLimit: base.wordLimit, newWordLimit: 0 }
        : limitsForStart(state, action.timezone, receivedAt);
    if (action.recovery) limits.wordLimit = Math.min(limits.wordLimit, recoveryWordLimit);
    if (!selected) {
      const available = miniCandidates(
        state.ledger,
        action.deck,
        receivedAt,
        state.scheduling,
        base.date,
      );
      if (
        dueWords.size === 0 &&
        (base.mode === 'reviewOnly' ||
          (v2
            ? extraGroupTarget === undefined && completedToday >= base.dailyNewGoal
            : limits.newWordLimit === 0) ||
          !available.candidates.some((word) => !available.schedules.has(wordKey(word))))
      )
        planError('当前没有可开始的新任务，原有进度已保留。');
    }
    for (const day of state.ledger.days)
      if (day.phase !== 'finished' && !day.paused && day.id !== selected?.id)
        pauseDay(day, receivedAt);
    // Only due reviews may come from another book. New words come from the selected book.
    const beginAction = !selected
      ? {
          ...action,
          deck: [
            ...action.deck,
            ...historicalDeck(state).filter((word) => dueWords.has(wordKey(word))),
          ],
          dayId: undefined,
          newGroup: true,
        }
      : action;
    const previousDayCount = state.ledger.days.length;
    applyMiniAction(state, beginAction, at, defaultTimezone, {
      limits,
      writingRequired: !reviewOnly,
      dayId: selected?.id,
      newGroup: !selected,
      ...(v2
        ? {
            flow: {
              dailyNewGoal: reviewOnly || restPractice ? 0 : base.dailyNewGoal,
              groupSize: base.groupSize,
              completedToday,
              ...(reviewOnly ? {} : extraBudget),
            },
          }
        : {}),
    });
    if (!selected && state.ledger.days.length === previousDayCount)
      planError('当前没有可开始的任务。');
    const day = selected ?? state.ledger.days.at(-1);
    if (day) {
      state.planning.activeDayId = day.id;
      const source =
        intent !== 'review' && state.planning.nextSessionOverride
          ? 'session'
          : action.recovery
            ? 'recovery'
            : base.todayOverride
              ? 'today'
              : 'default';
      openSession(
        state,
        day,
        action.timezone,
        receivedAt,
        limits,
        intent !== 'review' && (restPractice || action.overrideRest || continuedException),
        source,
        intent,
      );
      const opened = currentMiniPlanSession(state);
      if (restPractice && day.writingRequired === false && opened && learningGroup)
        opened.restStudyDayId = learningGroup.id;
      enforceBudget(state, day, receivedAt);
    }
    return;
  }
  if (action.target === 'daily' && pending && action.type === 'pause' && !action.paused) {
    const timezone = currentMiniPlanSession(state)?.timezone ?? pending.timezone ?? defaultTimezone;
    if (blockedMode(state, pending, timezone, receivedAt))
      planError('今日计划暂不安排这部分学习，请先修改计划。');
    if (
      pending.flow &&
      pending.phase !== 'review' &&
      outstandingReviews(state, receivedAt, date).size > 0
    )
      planError('请先完成到期复习，再继续新词；原进度已保留。');
    applyMiniAction(state, action, at, defaultTimezone);
    const source = state.planning.nextSessionOverride
      ? 'session'
      : basePlan(state, timezone, receivedAt).todayOverride
        ? 'today'
        : 'default';
    openSession(
      state,
      pending,
      timezone,
      receivedAt,
      limitsForStart(state, timezone, receivedAt),
      false,
      source,
    );
    enforceBudget(state, pending, receivedAt);
    return;
  }
  let activeSession = currentMiniPlanSession(state);
  if (
    !background &&
    action.target === 'daily' &&
    action.type !== 'pause' &&
    pending &&
    !pending.paused &&
    !activeSession
  ) {
    const timezone = pending.timezone ?? defaultTimezone;
    const freshLimits = limitsForStart(state, timezone, receivedAt);
    const source = state.planning.nextSessionOverride
      ? 'session'
      : basePlan(state, timezone, receivedAt).todayOverride
        ? 'today'
        : 'default';
    openSession(state, pending, timezone, receivedAt, freshLimits, false, source);
    activeSession = currentMiniPlanSession(state);
  }
  const boundaryWord =
    action.type === 'advance_translation' && pending
      ? currentTranslation(pending)?.sentence.word
      : 'word' in action
        ? action.word
        : undefined;
  const introducedNewWord =
    (action.type === 'mark_studied' || (action.type === 'memory_advance' && action.round === 1)) &&
    pending &&
    !pending.studiedWords.some((item) => spellingKey(item.word) === spellingKey(action.word));
  applyMiniAction(state, action, at, defaultTimezone, undefined, requestId);
  if (background || action.target !== 'daily' || !pending) return;
  if (action.type === 'pause' && action.paused) {
    finishSession(state, receivedAt, 'manual');
    return;
  }
  const boundary =
    action.type === 'window_advance' ||
    action.type === 'window_familiar' ||
    action.type === 'memory_advance' ||
    action.type === 'advance_judgment' ||
    action.type === 'mark_studied' ||
    action.type === 'advance_spelling' ||
    action.type === 'advance_translation' ||
    advancesCorrectSpelling(action) ||
    (action.type === 'submit_spelling' &&
      action.advanceOnCorrect &&
      action.answer.trim().toLowerCase() === action.word.spelling.toLowerCase());
  if (
    boundary &&
    boundaryWord &&
    activeSession &&
    !activeSession.servedWords.some((word) => spellingKey(word) === spellingKey(boundaryWord))
  )
    activeSession.servedWords.push(boundaryWord);
  if (
    (action.type === 'mark_studied' || (action.type === 'memory_advance' && action.round === 1)) &&
    introducedNewWord &&
    activeSession &&
    !(activeSession.newWords ?? []).some((word) => spellingKey(word) === spellingKey(action.word))
  )
    (activeSession.newWords ??= []).push(action.word);
  if (boundary && pending.phase !== 'finished')
    refreshFlowPlan(
      state,
      pending,
      activeSession?.timezone ?? pending.timezone ?? defaultTimezone,
      receivedAt,
    );
  if (
    pending.phase !== 'finished' &&
    blockedMode(
      state,
      pending,
      activeSession?.timezone ?? pending.timezone ?? defaultTimezone,
      receivedAt,
      activeSession?.overrideRest === true &&
        localDay(dateAt(activeSession.startedAt), activeSession.timezone) ===
          localDay(dateAt(receivedAt), activeSession.timezone),
    )
  )
    pauseSession(state, pending, receivedAt, 'rest');
  else if (boundary || action.type === 'complete_review' || action.type === 'complete_learning')
    enforceBudget(state, pending, receivedAt);
}

/** Called after the completed review has updated its authoritative due events. */
export function enforceMiniDueGate(
  state: MiniSnapshot,
  action: MiniAction,
  at: number,
  timezone: string,
  reviewSession?: MiniPlanSession,
) {
  if (
    action.target !== 'daily' ||
    !(
      advancesCorrectSpelling(action) ||
      [
        'window_advance',
        'window_familiar',
        'memory_advance',
        'advance_judgment',
        'mark_studied',
        'advance_spelling',
        'advance_translation',
        'complete_review',
        'complete_learning',
      ].includes(action.type)
    )
  )
    return;
  const completed =
    action.type === 'complete_review'
      ? state.ledger.days.find((item) => item.id === action.dayId)
      : undefined;
  const zone = completed?.timezone ?? currentMiniPlanSession(state)?.timezone ?? timezone;
  const date = localDay(dateAt(at), zone);
  if (completed && (completed.flow || reviewSession?.intent) && isMiniDayOnDate(completed, date)) {
    const reviewOnlyEntry =
      reviewSession?.intent === 'review' && reviewSession.dayId === completed.id;
    const overrideRest =
      reviewSession?.dayId === completed.id &&
      reviewSession.overrideRest === true &&
      localDay(dateAt(reviewSession.startedAt), reviewSession.timezone) === date;
    const mode = basePlan(state, zone, at).mode;
    if (mode !== 'rest' || overrideRest || reviewOnlyEntry) {
      const moreDue = outstandingReviews(state, at, date).size > 0;
      const restStudyDayId = overrideRest
        ? completed.writingRequired === false
          ? reviewSession.restStudyDayId
          : completed.id
        : undefined;
      // Review, spelling and scheduling share one group identity. Switch to the next
      // group only after those scheduling events are visible, in the same transaction.
      let next: MiniDay | undefined;
      if (moreDue)
        next = state.ledger.days.find(
          (item) => item.phase === 'review' && isMiniDayOnDate(item, date),
        );
      else if (reviewOnlyEntry) {
        if (completed.phase !== 'finished') pauseSession(state, completed, at, 'ended');
        return;
      } else if (completed.phase === 'finished') {
        if (mode === 'normal') next = recommendedDay(state, zone, at);
        else if (mode === 'rest' && restStudyDayId)
          next = state.ledger.days.find(
            (item) =>
              item.id === restStudyDayId &&
              item.phase === 'learning' &&
              isMiniDayOnDate(item, date),
          );
      }
      if (moreDue || (next?.flow && !next.flow.goalReached)) {
        applyMiniPlannedAction(
          state,
          {
            type: 'begin',
            target: 'daily',
            flowVersion: 'sliding-window-v2',
            timezone: zone,
            deck: [],
            ...(next && { dayId: next.id }),
            ...(reviewOnlyEntry
              ? { intent: 'review' }
              : overrideRest
                ? { overrideRest: true }
                : {}),
          },
          at,
          at,
          zone,
        );
        const session = currentMiniPlanSession(state);
        if (session && reviewSession?.intent) session.intent = reviewSession.intent;
        if (session?.overrideRest && moreDue && restStudyDayId)
          session.restStudyDayId = restStudyDayId;
        return;
      }
    }
  }
  const day = pendingMiniDay(state, date);
  if (
    day?.flow &&
    day.phase !== 'review' &&
    day.phase !== 'finished' &&
    outstandingReviews(state, at, date).size > 0
  )
    pauseSession(state, day, at, 'budget');
}

export function validateMiniPlanning(state: MiniSnapshot) {
  if (
    state.planning.activeDayId !== null &&
    !state.ledger.days.some((day) => day.id === state.planning.activeDayId)
  )
    planError('当前学习组身份不存在。');
  if (
    state.ledger.days.some(
      (day) => day.phase !== 'finished' && !day.paused && day.id !== state.planning.activeDayId,
    )
  )
    planError('未暂停组与当前学习组不一致。');
  const ids = new Set<string>();
  let active = 0;
  for (const session of state.planning.sessions) {
    const day = state.ledger.days.find((item) => item.id === session.dayId);
    if (
      session.restStudyDayId &&
      (!session.overrideRest ||
        !state.ledger.days.some(
          (item) =>
            item.id === session.restStudyDayId &&
            item.flow &&
            item.writingRequired !== false &&
            item.flow.targetDate === localDay(dateAt(session.startedAt), session.timezone),
        ))
    )
      planError('临时学习续接的原学习组无效。');
    if (
      !day ||
      ids.has(session.id) ||
      [...session.servedWords, ...(session.newWords ?? [])].some(
        (word) =>
          ![...day.reviewWords, ...day.learningWords].some((target) => sameWord(word, target)),
      ) ||
      new Set(session.servedWords.map(spellingKey)).size !== session.servedWords.length ||
      (session.endedAt !== undefined && session.endedAt < session.startedAt)
    )
      planError('本次计划与原始学习记录不一致。');
    ids.add(session.id);
    if (session.endedAt === undefined) {
      active += 1;
      if (day.phase === 'finished' || day.paused) planError('已暂停或完成的任务不能保留活动预算。');
      if (day.id !== state.planning.activeDayId) planError('活动预算与当前学习组不一致。');
    }
  }
  if (active > 1) planError('不能同时运行多个本次计划。');
}
