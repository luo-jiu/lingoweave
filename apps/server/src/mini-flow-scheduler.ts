import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  State,
  FSRSVersion,
  forgetting_curve,
  type Card,
} from 'ts-fsrs';
import {
  miniFlowScheduleEventSchema,
  type MiniDay,
  type MiniFlowScheduleCard,
  type MiniFlowScheduleEvent,
  type MiniSnapshot,
  type MiniWord,
  type MiniAssessmentApplication,
  type MiniAssessmentReceipt,
} from '@lingoweave/contracts';
import { LearningError } from './learning-store.js';
import { z } from 'zod';
import { calendarDue, localDay, sameWord, swiftTime, wordKey } from './mini-study.js';

const epoch = 978_307_200;
const dateAt = (at: number) => new Date((at + epoch) * 1000);
const parameters = generatorParameters({
  request_retention: 0.9,
  enable_fuzz: false,
  enable_short_term: true,
  learning_steps: [],
  relearning_steps: [],
});
const scheduler = fsrs(parameters);
if (FSRSVersion !== 'v5.4.2 using FSRS-6.0')
  throw new Error('The flow scheduler requires the locked ts-fsrs 5.4.2 FSRS-6 runtime.');
const parameterRecord = {
  retention: 0.9 as const,
  weights: [...parameters.w],
  learningSteps: [],
  relearningSteps: [],
  fuzzPolicy: 'bounded-load-v2' as const,
};
export function flowSenseId(word: MiniWord) {
  return `sense-${createHash('sha256').update(wordKey(word)).digest('hex')}`;
}
function encoded(card: Card) {
  const { due, last_review, ...rest } = card;
  return {
    ...rest,
    due: swiftTime(due),
    ...(last_review ? { last_review: swiftTime(last_review) } : {}),
  };
}
function decoded(card: NonNullable<MiniFlowScheduleCard['meaning']>): Card {
  const { last_review, ...rest } = card;
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
    due: dateAt(card.due),
    ...(last_review === undefined ? {} : { last_review: dateAt(last_review) }),
  };
}
// Many words share a review date. Cache only civil calendar boundaries, never
// a learner's due date or workload. Midnight can change offset or be skipped.
const dayStarts = new Map<string, number>();
function startOfFlowDay(
  at: number,
  shift: number,
  timezone: string,
  day = localDay(dateAt(at), timezone),
): number {
  const target = new Date(Date.parse(day) + shift * 86_400_000).toISOString().slice(0, 10);
  const key = `${timezone}/${target}`;
  const cached = dayStarts.get(key);
  if (cached !== undefined) return cached;
  const start = calendarDue(at, shift, timezone);
  if (dayStarts.size >= 2048) dayStarts.clear();
  dayStarts.set(key, start);
  return start;
}
export function nextFlowDay(at: number, timezone: string): number {
  return startOfFlowDay(at, 1, timezone);
}
function balancedDue(ideal: number, event: MiniFlowScheduleEvent): number {
  const idealDay = localDay(dateAt(ideal), event.timezone);
  const reviewedDay = localDay(dateAt(event.occurredAt), event.timezone);
  const days = (Date.parse(idealDay) - Date.parse(reviewedDay)) / 86_400_000;
  if (days < 3) return startOfFlowDay(ideal, 0, event.timezone, idealDay);
  const radius = Math.min(3, Math.max(1, Math.floor(days * 0.05)));
  const candidates = Array.from({ length: radius * 2 + 1 }, (_, i) => {
    const offset = i - radius;
    const date = startOfFlowDay(ideal, offset, event.timezone, idealDay);
    return { date, offset, load: event.load[localDay(dateAt(date), event.timezone)] ?? 0 };
  });
  return (
    candidates.sort(
      (a, b) => a.load - b.load || Math.abs(a.offset) - Math.abs(b.offset) || a.date - b.date,
    )[0]?.date ?? startOfFlowDay(ideal, 0, event.timezone, idealDay)
  );
}
function updateAbility(
  card: MiniFlowScheduleCard['meaning'],
  rating: MiniFlowScheduleEvent['meaning'],
  at: number,
) {
  if (rating === null) return card;
  const result = scheduler.next(
    card ? decoded(card) : createEmptyCard(dateAt(at)),
    dateAt(at),
    rating === 'Again' ? Rating.Again : rating === 'Hard' ? Rating.Hard : Rating.Good,
  );
  return encoded(result.card);
}
export function flowMemory(state: MiniSnapshot, word: MiniWord) {
  const id = flowSenseId(word);
  return state.scheduling.flow.cards.find((item) => item.senseId === id);
}
function orderedFlowEvents(state: MiniSnapshot, word: MiniWord) {
  const priority = { completion: 0, assessment: 1, review: 2, probe: 3 };
  const key = wordKey(word);
  return state.scheduling.flow.events
    .filter((event) => wordKey(event.word) === key)
    .sort(
      (a, b) =>
        a.occurredAt - b.occurredAt ||
        priority[a.kind] - priority[b.kind] ||
        a.id.localeCompare(b.id),
    );
}
/** Reconstructs ability states from occurrence order; late changes.after stores a later final state. */
export function flowMemoryHistory(state: MiniSnapshot, word: MiniWord) {
  let meaning: MiniFlowScheduleCard['meaning'] = null;
  let spelling: MiniFlowScheduleCard['spelling'] = null;
  return orderedFlowEvents(state, word).map((event) => {
    meaning = updateAbility(meaning, event.meaning, event.occurredAt);
    spelling = updateAbility(spelling, event.spelling, event.occurredAt);
    return { event, meaning, spelling };
  });
}
/** Continuous FSRS-6 estimate for display, not an observation or a due-date calculation. */
export function flowRetrievability(
  card: MiniFlowScheduleCard['meaning'] | undefined,
  at: number,
  weights: readonly number[] = parameters.w,
): number | null {
  const decay = weights[20];
  if (
    !card ||
    card.state === State.New ||
    card.last_review === undefined ||
    !Number.isFinite(card.last_review) ||
    !Number.isFinite(at) ||
    at < card.last_review ||
    !Number.isFinite(card.stability) ||
    card.stability <= 0 ||
    weights.length !== 21 ||
    weights.some((weight) => !Number.isFinite(weight)) ||
    decay === undefined ||
    decay < 0.1 ||
    decay > 0.8
  )
    return null;
  const estimate = forgetting_curve(weights, (at - card.last_review) / 86400, card.stability);
  return Number.isFinite(estimate) && estimate >= 0 && estimate <= 1 ? estimate : null;
}
function replay(
  state: MiniSnapshot,
  word: MiniWord,
  events = orderedFlowEvents(state, word),
): MiniFlowScheduleCard | undefined {
  let result: MiniFlowScheduleCard | undefined;
  let requiredReviewAt: number | undefined;
  // The first actual review after a difficulty starts its one- or two-day
  // ceiling. Its spelling and subsequent probes cannot restart that clock.
  let ceiling: { days: 1 | 2; origin?: string; firstReview?: string; dueAt?: number } | undefined;
  let lastReviewSource: string | undefined;
  for (const event of events) {
    const nextDay = nextFlowDay(event.occurredAt, event.timezone);
    const startsReview = event.kind === 'review' && event.sourceId !== lastReviewSource;
    if (startsReview) {
      lastReviewSource = event.sourceId;
      if (requiredReviewAt !== undefined && event.occurredAt >= requiredReviewAt)
        requiredReviewAt = undefined;
      if (ceiling && ceiling.origin !== event.sourceId) {
        if (ceiling.firstReview === undefined) {
          ceiling.firstReview = event.sourceId;
          ceiling.dueAt = startOfFlowDay(event.occurredAt, ceiling.days, event.timezone);
        } else ceiling = undefined;
      }
    }
    if (event.reviewCeilingDays !== undefined) {
      const days = event.reviewCeilingDays;
      if (event.kind === 'review') {
        // New difficulty belongs to this review. A previous, already served
        // review cannot tighten the limit attached to this new result.
        ceiling = { days, origin: event.sourceId };
      } else {
        ceiling = { days: days === 1 || ceiling?.days === 1 ? 1 : 2 };
      }
    }
    if (event.nextDay) requiredReviewAt = Math.min(requiredReviewAt ?? Infinity, nextDay);
    const meaning = updateAbility(result?.meaning ?? null, event.meaning, event.occurredAt);
    const spelling = updateAbility(result?.spelling ?? null, event.spelling, event.occurredAt);
    const changedAbility = event.meaning !== null || event.spelling !== null;
    // A combined review serves the word once. A spelling probe cannot discharge
    // an overdue combined review merely because the other ability was unmeasured.
    const overdueReview: MiniFlowScheduleCard | undefined =
      event.kind === 'probe' && result && result.dueAt <= event.occurredAt ? result : undefined;
    const meaningfulDue =
      event.meaning !== null || (meaning?.due ?? 0) > event.occurredAt ? meaning?.due : undefined;
    const spellingDue =
      event.spelling !== null || (spelling?.due ?? 0) > event.occurredAt
        ? spelling?.due
        : undefined;
    const limit = Math.min(requiredReviewAt ?? Infinity, ceiling?.dueAt ?? Infinity);
    const proposal = event.nextDay
      ? nextDay
      : changedAbility
        ? Math.max(nextDay, Math.min(meaningfulDue ?? Infinity, spellingDue ?? Infinity))
        : (result?.idealDueAt ?? nextDay);
    const idealDueAt = Math.min(proposal, limit, overdueReview?.idealDueAt ?? Infinity);
    // A supported spelling attempt saves evidence but does not get a second
    // allocation (or undo the date just allocated by its meaning judgment).
    let dueAt = idealDueAt;
    if (!event.nextDay) {
      if (result && (!changedAbility || idealDueAt === result.idealDueAt)) dueAt = result.dueAt;
      else if (idealDueAt !== nextDay && idealDueAt !== limit)
        dueAt = balancedDue(idealDueAt, event);
    }
    result = {
      senseId: flowSenseId(word),
      word,
      meaning,
      spelling,
      idealDueAt,
      dueAt: Math.min(overdueReview?.dueAt ?? dueAt, limit),
      updatedAt: event.occurredAt,
      lastEventId: event.id,
      reasons: event.reasons,
    };
  }
  return result;
}

/** Old releases replayed only events with exactly the same spelling, meaning and phonetic text. */
function matchesArchivedAbilityHistory(
  state: MiniSnapshot,
  card: MiniFlowScheduleCard,
  expected: MiniFlowScheduleCard,
) {
  if (expected.senseId !== card.senseId) return false;
  const all = orderedFlowEvents(state, card.word);
  const exact = all.filter((event) => sameWord(event.word, card.word));
  if (exact.length === all.length) return false;
  const former = replay(state, card.word, exact);
  return (
    !!former &&
    isDeepStrictEqual(card, { ...former, idealDueAt: card.idealDueAt, dueAt: card.dueAt })
  );
}
export function recordFlowSchedule(state: MiniSnapshot, raw: Omit<MiniFlowScheduleEvent, 'load'>) {
  const prior = state.scheduling.flow.events.find((event) => event.id === raw.id);
  if (prior) {
    if (!isDeepStrictEqual({ ...prior, load: {} }, { ...raw, load: {} }))
      throw new LearningError('MINI_SCHEDULE_CONFLICT', '同一学习事件的调度依据不能被覆盖。');
    return;
  }
  const load: Record<string, number> = {};
  const id = flowSenseId(raw.word);
  for (const card of state.scheduling.flow.cards) {
    if (card.senseId === id) continue;
    const date = localDay(dateAt(card.dueAt), raw.timezone);
    load[date] = (load[date] ?? 0) + 1;
  }
  const event = miniFlowScheduleEventSchema.parse({ ...raw, load });
  const before = flowMemory(state, event.word) ?? null;
  state.scheduling.flow.events.push(event);
  const after = replay(state, event.word);
  if (!after) throw new LearningError('MINI_SCHEDULE_CONFLICT', '缺少调度事件。');
  state.scheduling.flow.cards = state.scheduling.flow.cards.filter(
    (card) => card.senseId !== after.senseId,
  );
  state.scheduling.flow.cards.push(after);
  state.scheduling.flow.changes.push({
    id: randomUUID(),
    recordedAt: event.recordedAt,
    eventId: event.id,
    word: event.word,
    before,
    after,
    reason: event.reasons.join('；'),
    parameters: parameterRecord,
  });
}
const reviewHelpReason = '初选前已有帮助，不追加回忆成功；次日再复习。';
type ScheduleInput = Omit<MiniFlowScheduleEvent, 'load'>;
function reviewScheduleId(dayId: string, word: MiniWord) {
  return `review/${dayId}/${flowSenseId(word)}`;
}
function reviewScheduleEvents(
  state: MiniSnapshot,
  day: MiniDay,
  word: MiniWord,
  at: number,
): ScheduleInput[] {
  const review = day.review;
  if (!review) return [];
  const id = reviewScheduleId(day.id, word);
  const timezone = day.timezone ?? 'UTC';
  const judgments = review.judgmentEvents.filter(
    (event) => sameWord(event.word, word) && event.final !== undefined,
  );
  const first = judgments[0];
  if (!first) return [];
  const firstIndex = review.judgmentEvents.indexOf(first);
  const helpedBefore =
    (review.clearedJudgments ?? []).some(
      (item) => sameWord(item.word, word) && item.clearedAt <= first.selectedAt,
    ) ||
    state.teaching.exposures.some(
      (item) =>
        item.dayId === day.id &&
        item.session === 'review' &&
        !item.reviewPrompt &&
        !(item.source === 'audio' && item.audioKind === 'word') &&
        sameWord(item.word, word) &&
        (item.beforeJudgmentCount !== undefined
          ? item.beforeJudgmentCount <= firstIndex && item.at <= first.selectedAt
          : item.at < first.selectedAt),
    );
  const spelling = review.spellingAttempts.filter(
    (attempt) => sameWord(attempt.word, word) && attempt.kind === 'first',
  );
  const failed = spelling.filter((attempt) => !attempt.correct).length;
  const firstSpelling = spelling[0];
  const exposureAt = Math.max(
    firstSpelling?.lastAnswerRevealAt ?? first.selectedAt,
    firstSpelling?.lastPotentialHelpAt ?? -Infinity,
    ...judgments.map((event) => event.selectedAt),
    ...(review.relearning?.events ?? [])
      .filter((event) => sameWord(event.word, word))
      .map((event) => event.revealedAt ?? event.confirmedAt),
  );
  const hasIntervening =
    review.judgmentEvents.some(
      (event) =>
        !sameWord(event.word, word) &&
        event.selectedAt > exposureAt &&
        event.selectedAt < (firstSpelling?.submittedAt ?? 0),
    ) ||
    review.spellingAttempts.some(
      (event) =>
        !sameWord(event.word, word) &&
        event.submittedAt > exposureAt &&
        event.submittedAt < (firstSpelling?.submittedAt ?? 0),
    );
  const spellingQualified =
    firstSpelling !== undefined &&
    !firstSpelling.helpDuringAttempt &&
    firstSpelling.submittedAt - exposureAt >= (hasIntervening ? 60 : 300);
  const severe = judgments.filter((event) => event.final !== 'clear').length >= 3;
  const events: ScheduleInput[] = [
    {
      id,
      word,
      kind: 'review',
      sourceId: day.id,
      occurredAt: first.selectedAt,
      recordedAt: at,
      timezone,
      meaning:
        first.final === 'forgotten'
          ? 'Again'
          : helpedBefore
            ? null
            : first.final === 'fuzzy'
              ? 'Hard'
              : 'Good',
      spelling: null,
      evidence: 'self_report',
      nextDay: severe || helpedBefore,
      reasons: [
        first.final === 'clear'
          ? '复习初见自评清晰。'
          : first.final === 'fuzzy'
            ? '复习初见能想起核心意思，但模糊。'
            : '复习初见未能想起，后续重学不覆盖这次自评。',
        ...(severe ? ['三轮仍未清晰，完成重学后次日再复习。'] : []),
        ...(helpedBefore ? [reviewHelpReason] : []),
      ],
    },
  ];
  if (firstSpelling)
    events.push({
      id: `${id}/spelling`,
      word,
      kind: 'review',
      sourceId: day.id,
      occurredAt: firstSpelling.submittedAt,
      recordedAt: at,
      timezone,
      meaning: null,
      spelling: spellingQualified ? (firstSpelling.correct ? 'Good' : 'Again') : null,
      evidence: spellingQualified ? 'objective' : 'learning',
      nextDay: failed > 0 || severe || helpedBefore,
      ...(failed > 0 || severe
        ? { reviewCeilingDays: failed >= 3 || severe ? (1 as const) : (2 as const) }
        : {}),
      reasons: failed
        ? [`拼写有 ${failed} 轮首答错误，订正不另算失败；次日再复习。`]
        : [
            firstSpelling.helpDuringAttempt
              ? '本次拼写作答前已主动取用提示，仅作支持练习。'
              : spellingQualified
                ? '复习拼写首答正确，有保存的间隔和未帮助证据。'
                : '复习拼写完成；近期答案曝光，仅作支持练习，不追加独立 Good。',
          ],
    });
  return events;
}

/** Reclassify only a proved historical question that disqualified a saved judgment.
 * Keep the original event identities, balancing inputs and earlier audit entries. */
export function repairMiniReviewPromptSchedules(state: MiniSnapshot, at: number): boolean {
  const flow = state.scheduling.flow;
  const prompts = new Map<string, number>();
  for (const item of state.teaching.exposures) {
    if (!item.reviewPrompt || !item.dayId) continue;
    const id = reviewScheduleId(item.dayId, item.word);
    prompts.set(id, Math.min(prompts.get(id) ?? Infinity, item.at));
  }
  const saved = new Map(flow.events.map((event) => [event.id, event]));
  const originals = new Map<string, MiniFlowScheduleEvent[]>();
  for (const day of state.ledger.days) {
    if (!day.flow || !day.review || day.reviewFinishedAt === undefined) continue;
    for (const word of day.reviewWords) {
      const id = reviewScheduleId(day.id, word);
      const prior = saved.get(id);
      if (
        !prior ||
        !prior.reasons.includes(reviewHelpReason) ||
        (prompts.get(id) ?? Infinity) > prior.occurredAt
      )
        continue;
      const [judgment, spelling] = reviewScheduleEvents(state, day, word, at);
      if (!judgment || judgment.reasons.includes(reviewHelpReason)) continue;
      const key = flowSenseId(word);
      const replaced = originals.get(key) ?? [];
      originals.set(key, replaced);
      replaced.push(structuredClone(prior));
      prior.meaning = judgment.meaning;
      prior.nextDay = judgment.nextDay;
      prior.reasons = prior.reasons.filter((reason) => reason !== reviewHelpReason);
      const priorSpelling = spelling && saved.get(spelling.id);
      if (spelling && priorSpelling && priorSpelling.nextDay !== spelling.nextDay) {
        replaced.push(structuredClone(priorSpelling));
        priorSpelling.nextDay = spelling.nextDay;
      }
    }
  }
  for (const [senseId, replacedReviewEvents] of originals) {
    const index = flow.cards.findIndex((card) => card.senseId === senseId);
    const before = flow.cards[index];
    const event = replacedReviewEvents.at(-1);
    const after = before && replay(state, before.word);
    if (!before || !event || !after)
      throw new LearningError('MINI_SCHEDULE_CONFLICT', '无法从原始复习记录重算词义排期。');
    flow.cards[index] = after;
    flow.changes.push({
      id: randomUUID(),
      eventId: event.id,
      word: before.word,
      recordedAt: at,
      before,
      after,
      reason: '复习判断题面只展示英文。按原作答重新计算词义评级和复习日期。',
      replacedReviewEvents,
      parameters: parameterRecord,
    });
  }
  return originals.size > 0;
}
/** Derives events from committed user facts; no answer is created here. */
export function observeMiniFlowScheduling(state: MiniSnapshot, at: number) {
  for (const day of state.ledger.days) {
    if (!day.flow) continue;
    const timezone = day.timezone ?? 'UTC';
    for (const completed of day.flow.completed) {
      const id = `completion/${completed.attemptId.toLowerCase()}`;
      if (state.scheduling.flow.events.some((event) => event.id === id)) continue;
      const memoryMisses = day.flow.window.events.filter(
        (item) => sameWord(item.word, completed.word) && !item.remembered,
      ).length;
      const group = day.flow.groups.find((item) =>
        item.translationAttemptIds.includes(completed.attemptId),
      );
      const spellingMisses =
        (group?.spelling ?? day.learning)?.spellingAttempts.filter(
          (item) => sameWord(item.word, completed.word) && item.kind === 'first' && !item.correct,
        ).length ?? 0;
      const reviewCeilingDays =
        spellingMisses >= 3 || memoryMisses >= 3
          ? 1
          : spellingMisses > 0 || memoryMisses > 0
            ? 2
            : undefined;
      recordFlowSchedule(state, {
        id,
        word: completed.word,
        kind: 'completion',
        sourceId: completed.attemptId,
        occurredAt: completed.at,
        recordedAt: at,
        timezone,
        meaning: null,
        spelling: null,
        evidence: 'learning',
        nextDay: true,
        ...(reviewCeilingDays === undefined ? {} : { reviewCeilingDays }),
        reasons: [
          '完成新词学习，下一自然日首次复习；支持练习未伪装为独立成功。',
          ...(reviewCeilingDays === undefined
            ? []
            : [
                `有保存的记忆或拼写首答困难；首次真实复习后的间隔最多 ${reviewCeilingDays} 天，之后按新证据解除此限制。`,
              ]),
        ],
      });
    }
    if (day.reviewFinishedAt === undefined || !day.review) continue;
    for (const word of day.reviewWords) {
      const id = reviewScheduleId(day.id, word);
      const bothSaved =
        state.scheduling.flow.events.some((event) => event.id === id) &&
        state.scheduling.flow.events.some((event) => event.id === `${id}/spelling`);
      if (bothSaved) continue;
      for (const event of reviewScheduleEvents(state, day, word, at))
        if (!state.scheduling.flow.events.some((existing) => existing.id === event.id))
          recordFlowSchedule(state, event);
    }
  }
  for (const probe of state.scheduling.probes) {
    if (!probe.rating || probe.submittedAt === undefined || !flowMemory(state, probe.word))
      continue;
    const id = `probe/${probe.id}`;
    if (state.scheduling.flow.events.some((event) => event.id === id)) continue;
    recordFlowSchedule(state, {
      id,
      word: probe.word,
      kind: 'probe',
      sourceId: probe.id,
      occurredAt: probe.submittedAt,
      recordedAt: at,
      timezone:
        state.ledger.days.find((day) =>
          day.flow?.completed.some((item) => sameWord(item.word, probe.word)),
        )?.timezone ?? 'UTC',
      meaning: null,
      spelling: probe.rating,
      evidence: 'objective',
      nextDay: probe.rating === 'Again',
      reasons: [probe.reason ?? '独立拼写检验，按已保存的客观分类采用。'],
    });
  }
}
export function applyFlowAssessment(
  state: MiniSnapshot,
  input: MiniAssessmentApplication,
  at: number,
): MiniAssessmentReceipt {
  const { source, result } = input;
  const before = flowMemory(state, source.word)?.dueAt ?? null;
  const producesEnglish = source.question.direction === 'chineseToEnglish';
  const observations = producesEnglish
    ? [result.meaning, result.spelling, result.usage]
    : [result.meaning];
  const errors = observations.filter((observation) => observation.outcome === 'incorrect');
  const uncertain = observations.some((observation) => observation.outcome === 'uncertain');
  const reasons = errors.map((observation) => observation.explanation);
  const qualification = z
    .object({ meaning: z.boolean(), spelling: z.boolean() })
    .safeParse(source.learningEvidence.eligibility);
  const usable = result.uncertainties.length === 0;
  const grade = (
    observation: typeof result.meaning,
    eligible: boolean,
  ): MiniFlowScheduleEvent['meaning'] =>
    !usable || !eligible
      ? null
      : observation.outcome === 'correct'
        ? 'Good'
        : observation.outcome === 'incorrect'
          ? 'Again'
          : null;
  const meaning = grade(result.meaning, qualification.success && qualification.data.meaning);
  const spelling = grade(
    result.spelling,
    producesEnglish && qualification.success && qualification.data.spelling,
  );
  if (!reasons.length)
    reasons.push(
      uncertain
        ? '语义评价存在不确定项，保留明确的学习事实。'
        : meaning !== null || spelling !== null
          ? '按原答、帮助和实际间隔采用模型评价；首次次日复习仍保留。'
          : '已保存教学评价；近期曝光或目标未测到，未追加独立回忆成功。',
    );
  const definitiveError = errors.length > 0 && result.uncertainties.length === 0;
  const reviewCeilingDays = definitiveError
    ? producesEnglish && result.spelling.outcome === 'incorrect'
      ? 1
      : 2
    : undefined;
  if (reviewCeilingDays !== undefined)
    reasons.push(
      `采用目标词错误的保守限制：首次真实复习后的间隔最多 ${reviewCeilingDays} 天；不重复累计失败次数。`,
    );
  recordFlowSchedule(state, {
    id: `assessment/${source.id}`,
    word: source.word,
    kind: 'assessment',
    sourceId: source.id,
    occurredAt: source.confirmedAt,
    recordedAt: at,
    timezone: source.timezone,
    meaning,
    spelling,
    evidence: 'model',
    ...(reviewCeilingDays === undefined ? {} : { reviewCeilingDays }),
    nextDay:
      definitiveError ||
      state.scheduling.flow.events.some(
        (event) => event.kind === 'completion' && event.sourceId === source.attemptId,
      ),
    reasons,
  });
  return {
    requestId: input.requestId,
    sourceId: source.id,
    revision: state.revision + 1,
    disposition:
      uncertain || result.uncertainties.length > 0
        ? 'pending_review'
        : definitiveError
          ? 'adopted'
          : 'partially_adopted',
    reason: reasons.join('；'),
    scheduling: {
      beforeDueAt: before,
      afterDueAt: flowMemory(state, source.word)?.dueAt ?? null,
      policyVersion: 'mini-flow-scheduling-v1',
      reasons,
      affectedEvents: state.scheduling.flow.events.filter(
        (event) =>
          wordKey(event.word) === wordKey(source.word) && event.occurredAt >= source.confirmedAt,
      ).length,
    },
  };
}
function matchesArchivedDue(
  state: MiniSnapshot,
  card: MiniFlowScheduleCard,
  recomputed: MiniFlowScheduleCard | undefined,
  audited: MiniFlowScheduleCard | undefined,
) {
  return (
    recomputed !== undefined &&
    isDeepStrictEqual(card, audited) &&
    (isDeepStrictEqual(card, { ...recomputed, dueAt: card.dueAt, idealDueAt: card.idealDueAt }) ||
      matchesArchivedAbilityHistory(state, card, recomputed))
  );
}

/** Reconstruct from the saved evidence and its contemporary load, including past
 * variants of this sense. Preserve every historical observation and audit entry. */
export function rebuildMiniFlowDueSchedules(state: MiniSnapshot, at: number): boolean {
  const flow = state.scheduling.flow;
  const archived = new Map(flow.changes.map((change) => [change.after.senseId, change.after]));
  const repairs: { index: number; before: MiniFlowScheduleCard; after: MiniFlowScheduleCard }[] =
    [];
  for (const [index, before] of flow.cards.entries()) {
    const after = replay(state, before.word);
    if (isDeepStrictEqual(after, before)) continue;
    if (!after || !matchesArchivedDue(state, before, after, archived.get(before.senseId)))
      throw new LearningError('MINI_SCHEDULE_CONFLICT', '旧排期与已保存的学习证据或审计不一致。');
    repairs.push({ index, before, after });
  }
  for (const { index, before, after } of repairs) {
    flow.cards[index] = after;
    flow.changes.push({
      id: randomUUID(),
      eventId: after.lastEventId,
      word: before.word,
      recordedAt: at,
      before,
      after,
      reason: '按同一词义的原始记录（含音标或大小写变体）、当地自然日和当时负荷重新计算排期。',
      parameters: parameterRecord,
    });
  }
  return repairs.length > 0;
}

/** Omit affectedWords at trust boundaries; trusted append-only mutations may replay just their changed words. */
export function validateMiniFlowScheduling(
  state: MiniSnapshot,
  affectedWords?: readonly MiniWord[],
  options?: { allowArchivedDueDates: boolean },
) {
  const flow = state.scheduling.flow;
  const eventIds = new Set(flow.events.map((event) => event.id));
  if (eventIds.size !== flow.events.length)
    throw new LearningError('MINI_SCHEDULE_CONFLICT', '调度事件身份重复。');
  if (new Set(flow.cards.map((card) => card.senseId)).size !== flow.cards.length)
    throw new LearningError('MINI_SCHEDULE_CONFLICT', '词义排期重复。');
  const eventSenseIds = new Set(flow.events.map((event) => flowSenseId(event.word)));
  if (
    eventSenseIds.size !== flow.cards.length ||
    flow.cards.some(
      (card) => card.senseId !== flowSenseId(card.word) || !eventSenseIds.has(card.senseId),
    ) ||
    flow.changes.some((change) => !eventIds.has(change.eventId))
  )
    throw new LearningError('MINI_SCHEDULE_CONFLICT', '调度事件与词义排期数量不一致。');
  const affected = affectedWords === undefined ? undefined : new Set(affectedWords.map(wordKey));
  const archived = options?.allowArchivedDueDates
    ? new Map(flow.changes.map((change) => [change.after.senseId, change.after]))
    : undefined;
  for (const card of flow.cards) {
    if (affected && !affected.has(wordKey(card.word))) continue;
    const recomputed = replay(state, card.word);
    if (isDeepStrictEqual(recomputed, card)) continue;
    if (archived && matchesArchivedDue(state, card, recomputed, archived.get(card.senseId)))
      continue;
    throw new LearningError('MINI_SCHEDULE_CONFLICT', '排期与原始评价事件不一致。');
  }
}
