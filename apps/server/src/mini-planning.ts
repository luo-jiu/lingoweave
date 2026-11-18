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
import {
  applyMiniAction,
  currentLearningWord,
  currentMiniWindow,
  currentTranslation,
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
export function pendingMiniDay(state: MiniSnapshot) {
  const selected = state.ledger.days.find(
    (day) => day.id === state.planning.activeDayId && day.phase !== 'finished',
  );
  if (selected) return selected;
  return lastWhere(state.ledger.days, (day) => day.phase !== 'finished');
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
function historicalDeck(state: MiniSnapshot, deck: MiniWord[] = []) {
  const all = [
    ...deck,
    ...state.ledger.days.flatMap((day) => [...day.reviewWords, ...day.learningWords]),
  ];
  return [...new Map(all.map((word) => [wordKey(word), word])).values()];
}
function outstandingReviews(state: MiniSnapshot, at: number, deck: MiniWord[] = []) {
  const available = miniCandidates(state.ledger, historicalDeck(state, deck), at, state.scheduling);
  const pending = state.ledger.days
    .filter((day) => day.phase === 'review' && day.reviewFinishedAt === undefined)
    .flatMap((day) => day.reviewWords);
  return new Set([...available.due.map((item) => wordKey(item.word)), ...pending.map(wordKey)]);
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
  if (base.mode === 'rest' && !temporaryRestException) return false;
  return base.mode !== 'reviewOnly' || day.phase === 'review';
}
function recommendedDay(state: MiniSnapshot, timezone: string, at: number) {
  const selected = state.ledger.days.find(
    (day) =>
      day.id === state.planning.activeDayId &&
      day.phase !== 'finished' &&
      modeAllows(state, day, timezone, at),
  );
  return (
    selected ??
    lastWhere(
      state.ledger.days,
      (day) => day.phase !== 'finished' && modeAllows(state, day, timezone, at),
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
    active &&
    (active.source === 'session' ||
      localDay(dateAt(active.startedAt), active.timezone) === base.date)
      ? active
      : next;
  const { candidates, schedules } = miniCandidates(state.ledger, input.deck, at, state.scheduling);
  const lastActivityAt = lastMiniActivity(state);
  const completedNewCount = miniCompletedToday(state, input.timezone, at);
  const remainingNewCount = Math.max(0, base.dailyNewGoal - completedNewCount);
  const dueWords = outstandingReviews(state, at, input.deck);
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
  const pending =
    recommended?.flow?.goalReached && remainingNewCount === 0 && dueWords.size === 0
      ? undefined
      : recommended;
  const pendingGroups = state.ledger.days.flatMap((day) =>
    day.phase === 'finished'
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
  const hasCandidates =
    dueWords.size > 0 ||
    (base.mode === 'normal' &&
      remainingNewCount > 0 &&
      candidates.some((word) => !schedules.has(wordKey(word))));
  let blockedReason: string | null = null;
  if (base.mode === 'rest' && !pending)
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
    ...(overrideRest ? { overrideRest: true } : {}),
  });
  state.planning.nextSessionOverride = null;
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
  if (!day.flow || day.writingRequired === false || !isSafeBoundary(day)) return;
  const base = basePlan(state, timezone, at);
  if (
    day.flow.targetDate === base.date &&
    day.flow.dailyNewGoal === base.dailyNewGoal &&
    day.flow.groupSize === base.groupSize
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
    previousSession.source !== 'session' &&
    localDay(dateAt(previousSession.startedAt), previousSession.timezone) !==
      localDay(dateAt(receivedAt), previousSession.timezone)
  )
    finishSession(state, receivedAt, 'ended');
  const pending = pendingMiniDay(state);
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
    const active = currentMiniPlanSession(state);
    const continuedException =
      active?.overrideRest === true &&
      (!action.dayId || action.dayId === active.dayId) &&
      localDay(dateAt(active.startedAt), active.timezone) === base.date;
    if (base.mode === 'rest' && !action.overrideRest && !continuedException)
      planError('今天已休息；如需学习，请明确选择临时学一次。');
    let selected = action.newGroup
      ? undefined
      : action.dayId
        ? state.ledger.days.find((day) => day.id === action.dayId && day.phase !== 'finished')
        : base.mode === 'rest' && action.overrideRest
          ? pending
          : recommendedDay(state, action.timezone, receivedAt);
    if (action.dayId && !selected) planError('指定的学习组已完成或不存在，请刷新后重试。');
    const v2 = action.flowVersion === 'sliding-window-v2' || selected?.flow !== undefined;
    const completedToday = miniCompletedToday(state, action.timezone, receivedAt);
    const dueWords = outstandingReviews(state, receivedAt, action.deck);
    if (v2 && dueWords.size > 0 && selected?.phase !== 'review') {
      const unfinishedReview = state.ledger.days.find(
        (day) => day.phase === 'review' && day.reviewFinishedAt === undefined,
      );
      if (unfinishedReview) selected = unfinishedReview;
    }
    const deferred = v2 && selected && selected.phase !== 'review' && dueWords.size > 0;
    if (deferred)
      selected = state.ledger.days.find(
        (day) => day.phase === 'review' && modeAllows(state, day, action.timezone, receivedAt),
      );
    const existingFlow = state.ledger.days.find(
      (day) => day.flow && day.phase !== 'finished' && day.id !== selected?.id,
    );
    const reviewOnly =
      base.mode === 'reviewOnly' ||
      (!!deferred && !selected) ||
      (v2 && dueWords.size > 0 && !selected && !!existingFlow);
    if (selected && base.mode === 'reviewOnly' && selected.phase !== 'review')
      planError('今天只复习，上次的新词或写作进度已保留；请先修改今日计划。');
    if (selected?.flow) {
      const available = miniCandidates(state.ledger, action.deck, receivedAt, state.scheduling);
      resumeMiniFlow(
        selected,
        { dailyNewGoal: base.dailyNewGoal, groupSize: base.groupSize, completedToday },
        receivedAt,
        action.timezone,
        available.candidates.filter((word) => !available.schedules.has(wordKey(word))),
      );
      if (selected.flow.goalReached && dueWords.size === 0)
        planError('今日新词目标已完成，进行中的词已保留。');
    } else if (selected && action.flowVersion === 'memory-rounds-v1')
      startMiniMemoryRounds(selected);
    if (
      selected &&
      active?.dayId === selected.id &&
      !selected.paused &&
      !action.recovery &&
      !state.planning.nextSessionOverride
    ) {
      state.planning.activeDayId = selected.id;
      enforceBudget(state, selected, receivedAt);
      return;
    }
    const limits = limitsForStart(state, action.timezone, receivedAt);
    if (action.recovery) limits.wordLimit = Math.min(limits.wordLimit, recoveryWordLimit);
    if (!selected) {
      const available = miniCandidates(
        state.ledger,
        historicalDeck(state, action.deck),
        receivedAt,
        state.scheduling,
      );
      if (
        dueWords.size === 0 &&
        (base.mode === 'reviewOnly' ||
          (v2 ? completedToday >= base.dailyNewGoal : limits.newWordLimit === 0) ||
          !available.candidates.some((word) => !available.schedules.has(wordKey(word))))
      )
        planError('当前没有可开始的新任务，原有进度已保留。');
    }
    for (const day of state.ledger.days)
      if (day.phase !== 'finished' && !day.paused && day.id !== selected?.id)
        pauseDay(day, receivedAt);
    const beginAction =
      v2 && !selected
        ? { ...action, deck: historicalDeck(state, action.deck), dayId: undefined, newGroup: true }
        : action;
    applyMiniAction(state, beginAction, at, defaultTimezone, {
      limits,
      writingRequired: !reviewOnly,
      dayId: selected?.id,
      newGroup: !selected,
      ...(v2
        ? {
            flow: {
              dailyNewGoal: reviewOnly ? 0 : base.dailyNewGoal,
              groupSize: base.groupSize,
              completedToday,
            },
          }
        : {}),
    });
    const day = selected ?? state.ledger.days.at(-1);
    if (day) {
      state.planning.activeDayId = day.id;
      const source = state.planning.nextSessionOverride
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
        action.overrideRest || continuedException,
        source,
      );
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
      outstandingReviews(state, receivedAt).size > 0
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
  applyMiniAction(state, action, at, defaultTimezone);
  if (background || action.target !== 'daily' || !pending) return;
  if (action.type === 'pause' && action.paused) {
    finishSession(state, receivedAt, 'manual');
    return;
  }
  const boundary =
    action.type === 'window_advance' ||
    action.type === 'memory_advance' ||
    action.type === 'advance_judgment' ||
    action.type === 'mark_studied' ||
    action.type === 'advance_spelling' ||
    action.type === 'advance_translation' ||
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
export function enforceMiniDueGate(state: MiniSnapshot, action: MiniAction, at: number) {
  if (
    action.target !== 'daily' ||
    ![
      'window_advance',
      'memory_advance',
      'advance_judgment',
      'mark_studied',
      'advance_spelling',
      'advance_translation',
      'complete_review',
      'complete_learning',
    ].includes(action.type)
  )
    return;
  const day = pendingMiniDay(state);
  if (
    day?.flow &&
    day.phase !== 'review' &&
    day.phase !== 'finished' &&
    outstandingReviews(state, at).size > 0
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
