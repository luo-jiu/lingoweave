import { randomUUID } from 'node:crypto';
import type { MiniDay, MiniReviewSession, MiniSnapshot, MiniWord } from '@lingoweave/contracts';
import { makeMiniFlow } from './mini-flow.js';
import {
  finishMiniJudgments,
  historicalDeck,
  isMiniDayOnDate,
  localDay,
  makeReview,
  miniCandidates,
  unixDate,
  wordKey,
} from './mini-study.js';

function protectedReviewWords(state: MiniSnapshot, day: MiniDay, review: MiniReviewSession) {
  return new Set(
    [
      ...review.judgmentEvents.map((event) => event.word),
      ...(review.clearedJudgments ?? []).map((event) => event.word),
      ...state.teaching.exposures
        .filter((event) => event.dayId === day.id)
        .map((event) => event.word),
      ...state.teaching.focusItems
        .filter((item) => item.source.dayId === day.id)
        .flatMap((item) => item.words),
      ...state.practice.dictations.filter((item) => item.dayId === day.id).map((item) => item.word),
      ...state.planning.sessions
        .filter((item) => item.dayId === day.id)
        .flatMap((item) => item.servedWords),
    ].map(wordKey),
  );
}

/** Fit new review targets around the judgments and exposure already recorded. */
export function resizeMiniReview(
  state: MiniSnapshot,
  day: MiniDay,
  groupSize: number,
  at: number,
  date: string,
  deck: MiniWord[] = [],
) {
  const { review, flow } = day;
  if (
    !flow ||
    !isMiniDayOnDate(day, date) ||
    day.phase !== 'review' ||
    day.reviewFinishedAt !== undefined ||
    review?.phase !== 'judgment' ||
    review.relearning ||
    day.reviewWords.length === groupSize
  )
    return;

  if (day.reviewWords.length < groupSize) {
    const judged = new Set(review.judgmentEvents.map((event) => wordKey(event.word)));
    // Words assigned later still enter the first pass before any retries.
    // After a retry has been answered, the original order is already a fact.
    if (judged.size < review.judgmentEvents.length) return;
    const { due, canonical } = miniCandidates(
      state.ledger,
      historicalDeck(state, deck),
      at,
      state.scheduling,
      date,
    );
    const additions = due.slice(0, groupSize - day.reviewWords.length);
    if (!additions.length) return;
    const finalized = new Set(
      review.judgmentEvents
        .filter((event) => event.final !== undefined)
        .map((event) => wordKey(event.word)),
    );
    const retryIndex = review.queue.findIndex((word) => finalized.has(wordKey(word)));
    review.queue.splice(
      retryIndex === -1 ? review.queue.length : retryIndex,
      0,
      ...additions.map(({ word }) => word),
    );
    const materialKeys = new Set(day.sentences.map((sentence) => wordKey(sentence.word)));
    for (const { word, schedule } of additions) {
      day.reviewWords.push(word);
      day.reviewSteps.push(schedule.step);
      const key = wordKey(word);
      const sentence = canonical.get(key);
      if (sentence && !materialKeys.has(key)) day.sentences.push({ ...sentence, word });
    }
  } else {
    const keep = protectedReviewWords(state, day, review);
    const held = new Set(day.reviewWords.filter((word) => keep.has(wordKey(word))).map(wordKey));
    for (const word of day.reviewWords) {
      if (held.size >= groupSize) break;
      held.add(wordKey(word));
    }
    day.reviewSteps = day.reviewSteps.filter((_, index) => {
      const word = day.reviewWords[index];
      return word !== undefined && held.has(wordKey(word));
    });
    day.reviewWords = day.reviewWords.filter((word) => held.has(wordKey(word)));
    review.queue = review.queue.filter((word) => held.has(wordKey(word)));
    const materialKeys = new Set([...held, ...flow.candidates.map(wordKey)]);
    day.sentences = day.sentences.filter((sentence) => materialKeys.has(wordKey(sentence.word)));
  }
  review.words = [...day.reviewWords];
  if (review.queue.length === 0) finishMiniJudgments(review, at);
}

/** Split only unvisited words from an older all-due judgment queue. Existing commands,
 * help, material and scheduling identities remain attached to the original evidence. */
export function groupPendingMiniReviews(state: MiniSnapshot, at: number, timezone: string) {
  const additions: MiniDay[] = [];
  for (const day of state.ledger.days) {
    const { flow, review } = day;
    const zone = day.timezone ?? timezone;
    if (
      !flow ||
      day.phase !== 'review' ||
      !review ||
      review.phase !== 'judgment' ||
      review.relearning ||
      review.words.length <= flow.groupSize ||
      !isMiniDayOnDate(day, localDay(unixDate(at), zone))
    )
      continue;
    const current = review.queue[0];
    if (!current) continue;
    const keep = protectedReviewWords(state, day, review);
    keep.add(wordKey(current));
    const groupSize = flow.groupSize;
    const held = new Set(review.words.filter((word) => keep.has(wordKey(word))).map(wordKey));
    for (const word of review.words) {
      if (held.size >= groupSize) break;
      held.add(wordKey(word));
    }
    const originalWords = day.reviewWords;
    const waiting = originalWords.filter((word) => !held.has(wordKey(word)));
    if (!waiting.length) continue;
    const heldSteps: number[] = [];
    const waitingSteps: number[] = [];
    for (const [index, word] of originalWords.entries()) {
      const step = day.reviewSteps[index];
      if (step === undefined) throw new Error('旧复习词缺少原始调度步骤。');
      if (held.has(wordKey(word))) heldSteps.push(step);
      else waitingSteps.push(step);
    }
    const materials = new Map(day.sentences.map((sentence) => [wordKey(sentence.word), sentence]));
    const deferred = new Set(waiting.map(wordKey));
    day.reviewWords = day.reviewWords.filter((word) => !deferred.has(wordKey(word)));
    day.reviewSteps = heldSteps;
    review.words = [...day.reviewWords];
    review.queue = review.queue.filter((word) => !deferred.has(wordKey(word)));
    day.sentences = day.sentences.filter((sentence) => !deferred.has(wordKey(sentence.word)));
    for (let i = 0; i < waiting.length; i += groupSize) {
      const words = waiting.slice(i, i + groupSize);
      additions.push({
        id: flow.targetDate + '~' + randomUUID(),
        startedAt: at,
        timezone: zone,
        writingRequired: false,
        reviewWords: words,
        reviewSteps: waitingSteps.slice(i, i + groupSize),
        review: makeReview(words, false, false, true),
        phase: 'review',
        paused: true,
        flow: makeMiniFlow([], { dailyNewGoal: 0, groupSize }, at, zone),
        learningWords: [],
        directions: [],
        studiedWords: [],
        writingMode: 'prepared',
        sentences: words.flatMap((word) => materials.get(wordKey(word)) ?? []),
        writingPrompts: [],
        translation: [],
        translationDraft: '',
        translationIndex: 0,
        schedulerPolicy: 'fsrs-v1',
        scheduleUpdates: [],
      });
    }
  }
  for (const group of additions) state.ledger.days.push(group);
  return additions.length > 0;
}
