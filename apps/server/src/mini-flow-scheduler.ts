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
  type MiniFlowScheduleCard,
  type MiniFlowScheduleEvent,
  type MiniSnapshot,
  type MiniWord,
  type MiniAssessmentApplication,
  type MiniAssessmentReceipt,
} from '@lingoweave/contracts';
import { LearningError } from './learning-store.js';
import { z } from 'zod';
import { localDay, sameWord, swiftTime, wordKey } from './mini-study.js';

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
  fuzzPolicy: 'bounded-load-v1' as const,
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
export function nextFlowDay(at: number, timezone: string): number {
  const today = localDay(dateAt(at), timezone);
  let low = at,
    high = at + 36 * 3600;
  for (let index = 0; index < 40; index++) {
    const middle = (low + high) / 2;
    if (localDay(dateAt(middle), timezone) > today) high = middle;
    else low = middle;
  }
  return Math.ceil(high);
}
function shiftedDay(at: number, timezone: string, count: number) {
  const original = localDay(dateAt(at), timezone);
  const desired = new Date(Date.parse(`${original}T12:00:00Z`) + count * 86400000)
    .toISOString()
    .slice(0, 10);
  const estimate = swiftTime(new Date(`${desired}T12:00:00Z`));
  let low = estimate - 48 * 3600,
    high = estimate + 24 * 3600;
  for (let i = 0; i < 40; i++) {
    const middle = (low + high) / 2;
    if (localDay(dateAt(middle), timezone) >= desired) high = middle;
    else low = middle;
  }
  return Math.ceil(high);
}
function balancedDue(ideal: number, event: MiniFlowScheduleEvent): number {
  const days = (ideal - event.occurredAt) / 86400;
  if (days < 3 || event.nextDay) return ideal;
  const radius = Math.min(3, Math.max(1, Math.floor(days * 0.05)));
  const dates = Array.from({ length: radius * 2 + 1 }, (_, i) =>
    shiftedDay(ideal, event.timezone, i - radius),
  ).filter((date) => date >= nextFlowDay(event.occurredAt, event.timezone));
  return (
    dates.sort(
      (a, b) =>
        (event.load[localDay(dateAt(a), event.timezone)] ?? 0) -
          (event.load[localDay(dateAt(b), event.timezone)] ?? 0) ||
        Math.abs(a - ideal) - Math.abs(b - ideal) ||
        a - b,
    )[0] ?? ideal
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
  return state.scheduling.flow.cards.find((item) => item.senseId === flowSenseId(word));
}
function orderedFlowEvents(state: MiniSnapshot, word: MiniWord) {
  const priority = { completion: 0, assessment: 1, review: 2, probe: 3 };
  return state.scheduling.flow.events
    .filter((event) => sameWord(event.word, word))
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
function replay(state: MiniSnapshot, word: MiniWord): MiniFlowScheduleCard | undefined {
  const events = orderedFlowEvents(state, word);
  let result: MiniFlowScheduleCard | undefined;
  let firstReviewDue: number | undefined;
  let learningCeiling: 1 | 2 | undefined;
  let firstReviewSource: string | undefined;
  let ceilingOriginSource: string | undefined;
  for (const event of events) {
    if (event.kind === 'completion') firstReviewDue = nextFlowDay(event.occurredAt, event.timezone);
    if (event.reviewCeilingDays !== undefined) {
      learningCeiling = learningCeiling === 1 || event.reviewCeilingDays === 1 ? 1 : 2;
      if (event.kind === 'review') {
        ceilingOriginSource = event.sourceId;
        firstReviewSource = undefined;
      }
    }
    if (event.kind === 'review') {
      if (firstReviewDue !== undefined && event.occurredAt >= firstReviewDue)
        firstReviewDue = undefined;
      if (event.sourceId !== ceilingOriginSource) {
        if (firstReviewSource === undefined) firstReviewSource = event.sourceId;
        else if (firstReviewSource !== event.sourceId) learningCeiling = undefined;
      }
    }
    const meaning = updateAbility(result?.meaning ?? null, event.meaning, event.occurredAt);
    const spelling = updateAbility(result?.spelling ?? null, event.spelling, event.occurredAt);
    const nextDay = nextFlowDay(event.occurredAt, event.timezone);
    const changedAbility = event.meaning !== null || event.spelling !== null;
    // A completed combined review serves the word once. Keep unmeasured ability state,
    // but do not let an already-served stale due force daily returns forever.
    const meaningfulDue =
      event.meaning !== null || (meaning?.due ?? 0) > event.occurredAt ? meaning?.due : undefined;
    const spellingDue =
      event.spelling !== null || (spelling?.due ?? 0) > event.occurredAt
        ? spelling?.due
        : undefined;
    let idealDueAt = event.nextDay
      ? nextDay
      : changedAbility
        ? Math.max(nextDay, Math.min(meaningfulDue ?? Infinity, spellingDue ?? Infinity))
        : (result?.idealDueAt ?? nextDay);
    const ceiling =
      learningCeiling !== undefined && firstReviewSource !== undefined
        ? shiftedDay(event.occurredAt, event.timezone, learningCeiling)
        : undefined;
    if (ceiling !== undefined) idealDueAt = Math.min(idealDueAt, ceiling);
    if (firstReviewDue !== undefined) idealDueAt = Math.min(idealDueAt, firstReviewDue);
    const dueAt = event.nextDay || !changedAbility ? idealDueAt : balancedDue(idealDueAt, event);
    result = {
      senseId: flowSenseId(word),
      word,
      meaning,
      spelling,
      idealDueAt,
      dueAt: Math.min(dueAt, ceiling ?? Infinity, firstReviewDue ?? Infinity),
      updatedAt: event.occurredAt,
      lastEventId: event.id,
      reasons: event.reasons,
    };
  }
  return result;
}
export function recordFlowSchedule(state: MiniSnapshot, raw: Omit<MiniFlowScheduleEvent, 'load'>) {
  const prior = state.scheduling.flow.events.find((event) => event.id === raw.id);
  if (prior) {
    if (!isDeepStrictEqual({ ...prior, load: {} }, { ...raw, load: {} }))
      throw new LearningError('MINI_SCHEDULE_CONFLICT', '同一学习事件的调度依据不能被覆盖。');
    return;
  }
  const load: Record<string, number> = {};
  for (const card of state.scheduling.flow.cards) {
    if (sameWord(card.word, raw.word)) continue;
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
      const id = `review/${day.id}/${flowSenseId(word)}`;
      const judgments = day.review.judgmentEvents.filter(
        (event) => sameWord(event.word, word) && event.final !== undefined,
      );
      const first = judgments[0];
      if (!first) continue;
      const firstIndex = day.review.judgmentEvents.indexOf(first);
      const helpedBefore = state.teaching.exposures.some(
        (item) =>
          item.dayId === day.id &&
          item.session === 'review' &&
          !(item.source === 'audio' && item.audioKind === 'word') &&
          sameWord(item.word, word) &&
          (item.beforeJudgmentCount !== undefined
            ? item.beforeJudgmentCount <= firstIndex && item.at <= first.selectedAt
            : item.at < first.selectedAt),
      );
      const spelling = day.review.spellingAttempts.filter(
        (attempt) => sameWord(attempt.word, word) && attempt.kind === 'first',
      );
      const failed = spelling.filter((attempt) => !attempt.correct).length;
      const firstSpelling = spelling[0];
      const exposureAt = Math.max(
        firstSpelling?.lastAnswerRevealAt ?? first.selectedAt,
        firstSpelling?.lastPotentialHelpAt ?? -Infinity,
        ...judgments.map((event) => event.selectedAt),
        ...(day.review.relearning?.events ?? [])
          .filter((event) => sameWord(event.word, word))
          .map((event) => event.revealedAt ?? event.confirmedAt),
      );
      const hasIntervening =
        day.review.judgmentEvents.some(
          (event) =>
            !sameWord(event.word, word) &&
            event.selectedAt > exposureAt &&
            event.selectedAt < (firstSpelling?.submittedAt ?? 0),
        ) ||
        day.review.spellingAttempts.some(
          (event) =>
            !sameWord(event.word, word) &&
            event.submittedAt > exposureAt &&
            event.submittedAt < (firstSpelling?.submittedAt ?? 0),
        );
      const spellingQualified =
        firstSpelling !== undefined &&
        firstSpelling.submittedAt - exposureAt >= (hasIntervening ? 60 : 300);
      const severe = judgments.filter((event) => event.final !== 'clear').length >= 3;
      if (!state.scheduling.flow.events.some((event) => event.id === id)) {
        recordFlowSchedule(state, {
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
            ...(helpedBefore ? ['初选前已有帮助，不追加回忆成功；次日再复习。'] : []),
          ],
        });
      }
      const spellingId = `${id}/spelling`;
      if (firstSpelling && !state.scheduling.flow.events.some((event) => event.id === spellingId)) {
        recordFlowSchedule(state, {
          id: spellingId,
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
                spellingQualified
                  ? '复习拼写首答正确，有保存的间隔和未帮助证据。'
                  : '复习拼写完成；近期答案曝光，仅作支持练习，不追加独立 Good。',
              ],
        });
      }
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
  const errors = [result.meaning, result.spelling, result.usage].filter(
    (observation) => observation.outcome === 'incorrect',
  );
  const uncertain = [result.meaning, result.spelling, result.usage].some(
    (observation) => observation.outcome === 'uncertain',
  );
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
    source.question.direction === 'chineseToEnglish' &&
      qualification.success &&
      qualification.data.spelling,
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
    ? result.spelling.outcome === 'incorrect'
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
        (event) => sameWord(event.word, source.word) && event.occurredAt >= source.confirmedAt,
      ).length,
    },
  };
}
/** Omit affectedWords at trust boundaries; trusted append-only mutations may replay just their changed words. */
export function validateMiniFlowScheduling(
  state: MiniSnapshot,
  affectedWords?: readonly MiniWord[],
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
  for (const card of flow.cards)
    if (
      (affected === undefined || affected.has(wordKey(card.word))) &&
      !isDeepStrictEqual(replay(state, card.word), card)
    )
      throw new LearningError('MINI_SCHEDULE_CONFLICT', '排期与原始评价事件不一致。');
}
