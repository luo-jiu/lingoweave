import { randomUUID } from 'node:crypto';
import { miniReviewSessionSchema } from '@lingoweave/contracts';
import type {
  MiniAction,
  MiniDay,
  MiniLedger,
  MiniPlanLimits,
  MiniMemoryRounds,
  MiniReviewSession,
  MiniSchedule,
  MiniScheduling,
  MiniSnapshot,
  MiniTranslationTask,
  MiniWord,
} from '@lingoweave/contracts';
import { LearningError } from './learning-store.js';
import { validateMiniWritingLinks } from './mini-teaching.js';
import { orderMiniDue } from './mini-scheduler.js';
import {
  applyMiniWindowAction,
  beginMiniFlowLearning,
  currentMiniWindow,
  finishMiniFlowGroup,
  makeMiniFlow,
  makeMiniWindow,
  miniPreparationWords,
  miniWritingWords,
  validateMiniFlowDay,
  validateMiniWindow,
} from './mini-flow.js';
import type { MiniFlowOptions } from './mini-flow.js';
export {
  currentMiniWindow,
  miniPreparationWords,
  miniWritingWords,
  resumeMiniFlow,
  miniFlowCompletedToday,
} from './mini-flow.js';

const appleEpoch = 978_307_200;
const intervals = [1, 3, 7, 14, 30];
export function swiftTime(date: Date) {
  return date.getTime() / 1000 - appleEpoch;
}
function unixDate(time: number) {
  return new Date((time + appleEpoch) * 1000);
}
export function sameWord(a: MiniWord | undefined, b: MiniWord | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.spelling === b.spelling &&
    a.meaning === b.meaning &&
    a.phonetic === b.phonetic
  );
}
export function wordKey(word: MiniWord) {
  return JSON.stringify([word.spelling.trim().toLowerCase(), word.meaning.trim()]);
}
export function currentLearningWord(day: MiniDay): MiniWord | undefined {
  if (day.flow) return currentMiniWindow(day)?.visit?.word ?? day.learning?.queue[0];
  if (day.memory && day.memory.round <= 3) return day.memory.queue[0];
  return (
    day.retainedLearningWord ??
    day.learningWords.find((word) => !day.studiedWords.some((item) => sameWord(item.word, word))) ??
    day.learning?.queue[0]
  );
}
function exactKey(word: MiniWord) {
  return JSON.stringify([word.spelling, word.meaning, word.phonetic]);
}
function lastWhere<T>(values: T[], predicate: (value: T) => boolean): T | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined && predicate(value)) return value;
  }
  return undefined;
}
function unique(words: MiniWord[]) {
  const seen = new Set<string>();
  return words.filter((word) => {
    const key = exactKey(word);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function stateFocusExists(snapshot: MiniSnapshot, id: string, word: MiniWord) {
  return snapshot.teaching.focusItems.some(
    (focus) => focus.id === id && focus.words.some((item) => wordKey(item) === wordKey(word)),
  );
}
function invalid(message = '当前学习状态已变化，请刷新后重试。'): never {
  throw new LearningError('MINI_STATE_CONFLICT', message);
}
function check(condition: boolean, message?: string): asserts condition {
  if (!condition) invalid(message);
}

export function localDay(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (name: string) => parts.find((part) => part.type === name)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
// Find the actual beginning of the target calendar day, including 23/25-hour DST days.
export function calendarDue(at: number, days: number, timezone: string): number {
  const day = localDay(unixDate(at), timezone);
  const targetDate = new Date(`${day}T00:00:00.000Z`);
  targetDate.setUTCDate(targetDate.getUTCDate() + days);
  const target = targetDate.toISOString().slice(0, 10);
  let low = targetDate.getTime() - 36 * 3_600_000;
  let high = targetDate.getTime() + 36 * 3_600_000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDay(new Date(middle), timezone) < target) low = middle + 1;
    else high = middle;
  }
  return swiftTime(new Date(low));
}
export function makeReview(
  words: MiniWord[],
  fullBatchSpelling = false,
  retryErrors = false,
  flowV2 = false,
): MiniReviewSession {
  const distinct = unique(words);
  return {
    words: distinct,
    queue: [...distinct],
    ...(fullBatchSpelling ? { fullBatchSpelling: true } : {}),
    ...(flowV2
      ? { spellingPolicy: 'retry-errors-v2' as const, spellingSkips: [], relearningWords: [] }
      : retryErrors
        ? { spellingPolicy: 'retry-errors-v1' as const, spellingSkips: [] }
        : {}),
    phase: distinct.length === 0 ? 'finished' : fullBatchSpelling ? 'spelling' : 'judgment',
    judgmentEvents: [],
    spellingAttempts: [],
    spellingState: 'awaitingFirst',
    spellingDraft: '',
  };
}
function makeMemoryRounds(words: MiniWord[]): MiniMemoryRounds {
  return {
    version: 'three-rounds-v1',
    round: 1,
    queue: [...words],
    progress: words.map((word) => ({ word, completedRounds: 0 })),
    events: [],
    drafts: [],
    reveals: [],
    revealed: false,
  };
}
function advanceMemory(memory: MiniMemoryRounds, word: MiniWord, remembered: boolean) {
  check(memory.round <= 3 && sameWord(memory.queue[0], word));
  memory.queue.shift();
  if (remembered) {
    const progress = memory.progress.find((item) => sameWord(item.word, word));
    check(!!progress);
    progress.completedRounds = memory.round;
  } else memory.queue.push(word);
  memory.revealed = false;
  if (memory.queue.length === 0) {
    memory.round += 1;
    if (memory.round <= 3) memory.queue = memory.progress.map((item) => item.word);
  }
}
function memoryDraft(
  memory: MiniMemoryRounds,
  word: MiniWord,
  round: number,
  draft: string,
  at: number,
) {
  const previous = memory.drafts.find((item) => sameWord(item.word, word) && item.round === round);
  if (previous) Object.assign(previous, { text: draft, updatedAt: at });
  else memory.drafts.push({ word, round, text: draft, updatedAt: at });
}
function replayMemory(words: MiniWord[], events: MiniMemoryRounds['events']) {
  const replayed = makeMemoryRounds(words);
  for (const event of events) {
    if (event.undoneAt !== undefined) continue;
    check(replayed.round === event.round, '记忆轮次与保存的事实不一致。');
    advanceMemory(replayed, event.word, event.remembered);
  }
  return replayed;
}
/** A new explicit entry point can adopt the current flow before any legacy answer exists. */
export function startMiniMemoryRounds(day: MiniDay) {
  if (day.flow) return;
  if (day.phase === 'finished') return;
  if (day.review && day.review.spellingAttempts.length === 0) {
    day.review.spellingPolicy = 'retry-errors-v1';
    day.review.spellingSkips = [];
  }
  if (day.memory || !day.learning) return;
  if (
    day.studiedWords.length ||
    day.studyMarkEvents?.length ||
    day.learning.spellingAttempts.length ||
    day.learning.judgmentEvents.length ||
    day.review?.spellingAttempts.length ||
    day.review?.judgmentEvents.length ||
    day.translation.length
  )
    return;
  day.memory = makeMemoryRounds(day.learningWords);
  day.learning.spellingPolicy = 'retry-errors-v1';
  day.learning.spellingSkips = [];
}
function pendingJudgment(session: MiniReviewSession) {
  const event = session.judgmentEvents.at(-1);
  return session.phase === 'judgment' && event?.final === undefined ? event : undefined;
}
function lastSpelling(session: MiniReviewSession) {
  return session.phase === 'spelling' && session.spellingState !== 'awaitingFirst'
    ? session.spellingAttempts.at(-1)
    : undefined;
}
function exposure(session: MiniReviewSession, word: MiniWord) {
  return (
    lastWhere(
      session.spellingAttempts,
      (attempt) => sameWord(attempt.word, word) && attempt.revealedAnswerAt !== undefined,
    )?.revealedAnswerAt ??
    lastWhere(session.judgmentEvents, (event) => sameWord(event.word, word))?.selectedAt
  );
}
function chooseJudgment(
  session: MiniReviewSession,
  judgment: 'clear' | 'fuzzy' | 'forgotten',
  at: number,
) {
  const word = session.queue[0];
  check(session.phase === 'judgment' && !!word && !pendingJudgment(session));
  session.judgmentEvents.push({ word, selected: judgment, selectedAt: at });
}
function advanceJudgment(session: MiniReviewSession, markWrong: boolean, at: number) {
  const event = pendingJudgment(session);
  const word = session.queue[0];
  check(!!event && !!word);
  event.final = markWrong ? 'forgotten' : event.selected;
  event.finalizedAt = at;
  session.queue.shift();
  if (
    event.final !== 'clear' &&
    session.judgmentEvents.filter(
      (item) => sameWord(item.word, word) && (item.final === 'fuzzy' || item.final === 'forgotten'),
    ).length < 3
  )
    session.queue.push(word);
  if (
    session.spellingPolicy === 'retry-errors-v2' &&
    event.final !== 'clear' &&
    session.judgmentEvents.filter((item) => sameWord(item.word, word) && item.final !== undefined)
      .length >= 3
  ) {
    (session.relearningWords ??= []).push(word);
  }
  if (
    session.queue.length === 0 &&
    session.spellingPolicy === 'retry-errors-v2' &&
    session.relearningWords?.length
  ) {
    session.relearning = makeMiniWindow(session.relearningWords, at);
    return;
  }
  if (session.queue.length === 0) {
    session.phase = 'spelling';
    session.queue = [...session.words];
    session.spellingDraft = '';
  }
}
function submitSpelling(
  session: MiniReviewSession,
  raw: string,
  at: number,
  help?: { answerRevealAt?: number; potentialHelpAt?: number },
) {
  const word = session.queue[0];
  const previous = lastSpelling(session);
  check(
    session.phase === 'spelling' &&
      (session.spellingState === 'awaitingFirst' || session.spellingState === 'correcting') &&
      !!word &&
      raw.trim().length > 0 &&
      raw !== previous?.answer,
  );
  const kind = session.spellingState === 'awaitingFirst' ? 'first' : 'correction';
  const encounter =
    previous?.encounter ??
    session.spellingAttempts.filter(
      (attempt) => sameWord(attempt.word, word) && attempt.kind === 'first',
    ).length + 1;
  const correct = raw.trim().toLowerCase() === word.spelling.toLowerCase();
  const baseExposure = exposure(session, word);
  const lastAnswerRevealAt =
    baseExposure === undefined
      ? help?.answerRevealAt
      : help?.answerRevealAt === undefined
        ? baseExposure
        : Math.max(baseExposure, help.answerRevealAt);
  session.spellingAttempts.push({
    word,
    encounter,
    kind,
    answer: raw,
    correct,
    submittedAt: at,
    ...(lastAnswerRevealAt === undefined ? {} : { lastAnswerRevealAt }),
    ...(help?.potentialHelpAt === undefined ? {} : { lastPotentialHelpAt: help.potentialHelpAt }),
    ...(kind === 'first' && !correct ? { revealedAnswerAt: at } : {}),
  });
  session.spellingDraft = raw;
  if (
    !correct &&
    kind === 'first' &&
    encounter >= (session.spellingPolicy === 'retry-errors-v2' ? 3 : 5) &&
    (session.spellingPolicy === 'retry-errors-v1' || session.spellingPolicy === 'retry-errors-v2')
  ) {
    (session.spellingSkips ??= []).push({
      word,
      round: session.spellingPolicy === 'retry-errors-v2' ? 3 : 5,
      at,
    });
    session.spellingState = 'skipped';
  } else session.spellingState = correct ? 'readyToAdvance' : 'correcting';
}
function advanceSpelling(session: MiniReviewSession) {
  const attempt = lastSpelling(session);
  check(
    session.phase === 'spelling' &&
      (session.spellingState === 'readyToAdvance' || session.spellingState === 'skipped') &&
      !!attempt,
  );
  check(
    (attempt.correct || session.spellingState === 'skipped') &&
      sameWord(attempt.word, session.queue[0]),
  );
  session.queue.shift();
  if (
    session.spellingPolicy === 'retry-errors-v1' ||
    session.spellingPolicy === 'retry-errors-v2'
  ) {
    const first = session.spellingAttempts.find(
      (item) =>
        sameWord(item.word, attempt.word) &&
        item.encounter === attempt.encounter &&
        item.kind === 'first',
    );
    if (
      first &&
      !first.correct &&
      attempt.encounter < (session.spellingPolicy === 'retry-errors-v2' ? 3 : 5)
    )
      session.queue.push(attempt.word);
  } else if (session.fullBatchSpelling === true) {
    if (
      session.queue.length === 0 &&
      session.spellingAttempts.some(
        (item) => item.encounter === attempt.encounter && item.kind === 'first' && !item.correct,
      )
    )
      session.queue = [...session.words];
  } else if (attempt.kind === 'correction') session.queue.push(attempt.word);
  session.spellingDraft = '';
  session.spellingState = 'awaitingFirst';
  if (session.queue.length === 0) session.phase = 'finished';
}
export function currentTranslation(day: MiniDay): MiniTranslationTask | undefined {
  if (day.phase !== 'translation') return undefined;
  const id = `${day.id}/${day.translationIndex}`;
  const submitted = day.translation.find((attempt) => attempt.task.id === id);
  if (submitted) return submitted.task;
  const word = miniWritingWords(day)[day.translationIndex];
  const direction = day.directions[day.translationIndex];
  const prompt = day.writingPrompts?.find(
    (item) => sameWord(item.sentence.word, word) && item.direction === direction,
  );
  if (prompt)
    return {
      id,
      sentence: prompt.sentence,
      direction: prompt.direction,
      materialId: prompt.id,
      focusIds: prompt.focusIds,
    };
  if (day.writingMode === 'prepared') return undefined;
  const sentence = day.sentences.find((item) => sameWord(item.word, word));
  return sentence && direction ? { id, sentence, direction } : undefined;
}
function currentAttempt(day: MiniDay) {
  const task = currentTranslation(day);
  return task ? lastWhere(day.translation, (item) => item.task.id === task.id) : undefined;
}
function schedule(
  day: MiniDay,
  word: MiniWord,
  step: number,
  source: MiniSchedule['source'],
  at: number,
  timezone: string,
  interval?: number,
) {
  const dueAt = calendarDue(at, interval ?? intervals[step] ?? 1, day.timezone ?? timezone);
  day.scheduleUpdates.push({ word, dueAt, step, source, recordedAt: at, policyVersion: 1 });
}
function beginTranslation(day: MiniDay, at: number) {
  day.phase = 'translation';
  day.translationStartedAt = at;
}
export function miniCandidates(
  ledger: MiniLedger,
  deck: MiniWord[],
  at: number,
  scheduling?: MiniScheduling,
) {
  const schedules = new Map<string, MiniSchedule>();
  const canonical = new Map<string, MiniDay['sentences'][number]>();
  const directions = new Map<string, MiniTranslationTask['direction']>();
  for (const day of ledger.days) {
    for (const item of day.scheduleUpdates) {
      const prior = schedules.get(wordKey(item.word));
      if (!prior || item.recordedAt >= prior.recordedAt) schedules.set(wordKey(item.word), item);
    }
    for (const item of day.sentences)
      if (!canonical.has(wordKey(item.word))) canonical.set(wordKey(item.word), item);
    for (const item of day.translation)
      if (item.feedback) directions.set(wordKey(item.task.sentence.word), item.task.direction);
  }
  const unfinishedFlowWords = new Set(
    ledger.days.flatMap((day) =>
      day.flow
        ? day.learningWords
            .filter(
              (word) => !day.flow?.completed.some((item) => wordKey(item.word) === wordKey(word)),
            )
            .map(wordKey)
        : [],
    ),
  );
  const enrolled = new Set(
    ledger.days.flatMap((day) => [...day.reviewWords, ...day.learningWords].map(wordKey)),
  );
  for (const card of scheduling?.cards ?? []) {
    if (unfinishedFlowWords.has(wordKey(card.word))) continue;
    // A standalone support exercise does not silently enroll a word in a course.
    // Its pending probe remains available; explicit continuation can still teach it.
    if (card.fsrs === null && !enrolled.has(wordKey(card.word))) continue;
    schedules.set(wordKey(card.word), {
      word: card.word,
      dueAt: Math.min(card.dueAt, card.nextProbeAt ?? Infinity),
      step: 0,
      recordedAt: card.fsrs?.last_review ?? card.introducedAt,
      source: 'review',
      policyVersion: 1,
    });
  }
  for (const card of scheduling?.flow.cards ?? []) {
    if (unfinishedFlowWords.has(wordKey(card.word))) continue;
    schedules.set(wordKey(card.word), {
      word: card.word,
      dueAt: card.dueAt,
      step: 0,
      recordedAt: card.updatedAt,
      source: 'review',
      policyVersion: 1,
    });
  }
  const seen = new Set<string>();
  const reservedNew = new Set(
    ledger.days
      .filter((day) => day.phase !== 'finished')
      .flatMap((day) =>
        day.flow
          ? day.learningWords
              .filter(
                (word) => !day.flow?.completed.some((item) => wordKey(item.word) === wordKey(word)),
              )
              .map(wordKey)
          : day.learningFinishedAt === undefined
            ? day.learningWords.map(wordKey)
            : [],
      ),
  );
  const reservedReview = new Set(
    ledger.days
      .filter((day) => day.phase === 'review')
      .flatMap((day) => day.reviewWords.map(wordKey)),
  );
  const candidates = deck.filter((word) => {
    const key = wordKey(word);
    if (!word.spelling.trim() || !word.meaning.trim() || seen.has(key) || reservedNew.has(key))
      return false;
    seen.add(key);
    return true;
  });
  const due = candidates
    .map((word, position) => ({ word, position, schedule: schedules.get(wordKey(word)) }))
    .filter(
      (item): item is { word: MiniWord; position: number; schedule: MiniSchedule } =>
        !!item.schedule && item.schedule.dueAt <= at && !reservedReview.has(wordKey(item.word)),
    )
    .sort((a, b) => a.schedule.dueAt - b.schedule.dueAt || a.position - b.position);
  return {
    candidates,
    schedules,
    canonical,
    directions,
    due: scheduling ? orderMiniDue(due, scheduling, at) : due,
  };
}
function beginDaily(
  ledger: MiniLedger,
  deck: MiniWord[],
  at: number,
  timezone: string,
  options?: {
    limits: MiniPlanLimits;
    writingRequired: boolean;
    newGroup?: boolean;
    dayId?: string;
    flow?: MiniFlowOptions;
  },
  scheduling?: MiniScheduling,
) {
  if (options?.dayId) return;
  if (!options?.newGroup && lastWhere(ledger.days, (day) => day.phase !== 'finished')) return;
  const date = localDay(unixDate(at), timezone);
  const id = ledger.days.some((day) => day.id === date) ? `${date}~${randomUUID()}` : date;
  const {
    candidates,
    schedules,
    canonical,
    directions,
    due: allDue,
  } = miniCandidates(ledger, deck, at, scheduling);
  const limits = options?.limits ?? { wordLimit: 10, newWordLimit: 5 };
  if (options?.flow) {
    const reviewWords = allDue.map((item) => item.word);
    const flow = makeMiniFlow(
      candidates.filter((word) => !schedules.has(wordKey(word))),
      options.flow,
      at,
      timezone,
    );
    if (reviewWords.length === 0 && flow.candidates.length === 0) return;
    const day: MiniDay = {
      id,
      startedAt: at,
      timezone,
      ...(options.writingRequired === false ? { writingRequired: false } : {}),
      reviewWords,
      learningWords: [],
      reviewSteps: allDue.map((item) => item.schedule.step),
      directions: [],
      ...(reviewWords.length ? { review: makeReview(reviewWords, false, false, true) } : {}),
      flow,
      paused: false,
      phase: reviewWords.length ? 'review' : 'learning',
      studiedWords: [],
      sentences: [...reviewWords, ...flow.candidates].flatMap((word) => {
        const saved = canonical.get(wordKey(word));
        return saved ? [{ ...saved, word }] : [];
      }),
      writingMode: 'prepared',
      schedulerPolicy: 'fsrs-v1',
      writingPrompts: [],
      translation: [],
      translationDraft: '',
      translationIndex: 0,
      scheduleUpdates: [],
    };
    if (reviewWords.length === 0) beginMiniFlowLearning(day, at);
    ledger.days.push(day);
    return;
  }
  const spellings = new Set<string>();
  const normalized = (word: MiniWord) => word.spelling.trim().toLowerCase();
  const due = allDue
    .filter((item) => {
      const key = normalized(item.word);
      if (!spellings.has(key) && spellings.size >= limits.wordLimit) return false;
      if (spellings.size >= 5) return false;
      spellings.add(key);
      return true;
    })
    .slice(0, 5);
  // Only the selected due targets consume capacity; later due entries stay due.
  spellings.clear();
  for (const item of due) spellings.add(normalized(item.word));
  const reviewWords = due.map((item) => item.word);
  const newSpellings = new Set<string>();
  const learningWords: MiniWord[] = [];
  for (const word of candidates) {
    if (learningWords.length >= 5 || limits.newWordLimit === 0) break;
    if (schedules.has(wordKey(word))) continue;
    const key = normalized(word);
    if (
      (!spellings.has(key) && spellings.size >= limits.wordLimit) ||
      (!newSpellings.has(key) && newSpellings.size >= limits.newWordLimit)
    )
      continue;
    spellings.add(key);
    newSpellings.add(key);
    learningWords.push(word);
  }
  const planned = [...reviewWords, ...learningWords];
  if (planned.length === 0) return;
  const day: MiniDay = {
    id,
    startedAt: at,
    timezone,
    ...(options?.writingRequired === false ? { writingRequired: false } : {}),
    reviewWords,
    learningWords,
    reviewSteps: due.map((item) => item.schedule.step),
    directions: planned.map((word, index) => {
      const prior = directions.get(wordKey(word));
      return prior
        ? prior === 'englishToChinese'
          ? 'chineseToEnglish'
          : 'englishToChinese'
        : index % 2 === 0
          ? 'englishToChinese'
          : 'chineseToEnglish';
    }),
    ...(reviewWords.length > 0 ? { review: makeReview(reviewWords) } : {}),
    ...(learningWords.length > 0 ? { learning: makeReview(learningWords, true) } : {}),
    paused: false,
    phase: reviewWords.length > 0 ? 'review' : learningWords.length > 0 ? 'learning' : 'finished',
    ...(reviewWords.length === 0 && learningWords.length > 0 ? { learningStartedAt: at } : {}),
    ...(planned.length === 0 ? { finishedAt: at } : {}),
    studiedWords: [],
    sentences: planned.flatMap((word) => {
      const saved = canonical.get(wordKey(word));
      return saved ? [{ ...saved, word }] : [];
    }),
    writingMode: 'prepared',
    schedulerPolicy: 'fsrs-v1',
    writingPrompts: [],
    translation: [],
    translationDraft: '',
    translationIndex: 0,
    scheduleUpdates: [],
  };
  ledger.days.push(day);
}

export function applyMiniAction(
  state: MiniSnapshot,
  action: Exclude<
    MiniAction,
    {
      type:
        | 'set_long_term_plan'
        | 'set_today_plan'
        | 'clear_today_plan'
        | 'set_session_plan'
        | 'clear_session_plan'
        | 'end_session';
    }
  >,
  at: number,
  timezone: string,
  options?: {
    limits: MiniPlanLimits;
    writingRequired: boolean;
    newGroup?: boolean;
    dayId?: string;
    flow?: MiniFlowOptions;
  },
): void {
  if (
    action.type === 'create_focus' ||
    action.type === 'update_focus' ||
    action.type === 'remember_preference' ||
    action.type === 'forget_preference' ||
    action.type === 'record_exposure'
  )
    invalid('教学命令必须由教学服务处理。');
  if (action.type === 'begin') {
    if (action.target === 'daily') {
      beginDaily(state.ledger, action.deck, at, action.timezone, options, state.scheduling);
      if (action.flowVersion === 'memory-rounds-v1' && !options?.dayId) {
        const day = state.ledger.days.at(-1);
        if (day) startMiniMemoryRounds(day);
      }
      return;
    }
    if (state.reviewRecord && state.reviewRecord.session.phase !== 'finished') {
      const session = state.reviewRecord.session;
      if (action.flowVersion && session.spellingAttempts.length === 0) {
        session.spellingPolicy = 'retry-errors-v1';
        session.spellingSkips = [];
      }
      return;
    }
    if (
      state.reviewRecord &&
      !state.reviewHistory.some((item) => item.id === state.reviewRecord?.id)
    )
      state.reviewHistory.push(structuredClone(state.reviewRecord));
    const start = action.deck.length > 0 ? (action.startIndex ?? 0) % action.deck.length : 0;
    const words = action.deck.slice(start, start + 5);
    state.reviewRecord = {
      id: randomUUID(),
      session: makeReview(words, false, action.flowVersion !== undefined),
      paused: false,
      continuedToLearning: false,
      nextWordIndex: action.deck.length > 0 ? (start + words.length) % action.deck.length : 0,
    };
    return;
  }
  if (
    action.type === 'begin_probe' ||
    action.type === 'submit_probe' ||
    action.type === 'reveal_probe' ||
    action.type === 'end_probe' ||
    action.type === 'record_probe_help' ||
    action.type === 'hide_card'
  )
    invalid();
  let day: MiniDay | undefined;
  if (action.target === 'daily') {
    day = lastWhere(state.ledger.days, (item) => item.id === action.dayId);
    check(!!day);
    if (!day) invalid();
    if (
      action.type !== 'add_sentences' &&
      action.type !== 'record_feedback' &&
      action.type !== 'qualitative_feedback' &&
      action.type !== 'publish_writing'
    )
      check(state.planning.activeDayId === null || state.planning.activeDayId === day.id);
    if (action.type === 'pause') {
      check(day.phase !== 'finished');
      if (day.paused !== action.paused) {
        day.paused = action.paused;
        (day.pauseEvents ??= []).push({ paused: action.paused, at });
      }
      return;
    }
    if (action.type === 'add_sentences') {
      check(day.phase !== 'finished');
      const missing = miniPreparationWords(day).filter(
        (word) => !day?.sentences.some((item) => sameWord(item.word, word)),
      );
      check(
        unique(action.sentences.map((item) => item.word)).length === action.sentences.length &&
          action.sentences.every(
            (item) =>
              missing.some((word) => sameWord(word, item.word)) &&
              item.english.trim().length > 0 &&
              item.chinese.trim().length > 0,
          ),
        '例句与待准备的单词不匹配。',
      );
      day.sentences.push(...action.sentences);
      return;
    }
    if (action.type === 'publish_writing') {
      check(day.phase !== 'finished' && day.writingRequired !== false);
      const targets = miniWritingWords(day);
      const prompts = day.writingPrompts ?? [];
      const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
      check(
        new Set(action.prompts.map((item) => item.id)).size === action.prompts.length &&
          new Set(action.prompts.map((item) => wordKey(item.sentence.word))).size ===
            action.prompts.length,
        '写作材料身份或目标重复。',
      );
      for (const item of action.prompts) {
        const index = targets.findIndex((word) => sameWord(word, item.sentence.word));
        const learningSentence = day.sentences.find((sentence) =>
          sameWord(sentence.word, item.sentence.word),
        );
        check(
          index >= day.translationIndex &&
            day.directions[index] === item.direction &&
            !prompts.some(
              (prompt) =>
                prompt.id === item.id || sameWord(prompt.sentence.word, item.sentence.word),
            ) &&
            !day.translation.some((attempt) =>
              sameWord(attempt.task.sentence.word, item.sentence.word),
            ) &&
            item.sentence.english.trim().length > 0 &&
            item.sentence.chinese.trim().length > 0,
          '写作材料与待准备目标不匹配，不能覆盖已发布或已作答材料。',
        );
        check(
          !learningSentence ||
            normalize(learningSentence.english) !== normalize(item.sentence.english),
          '写作练习需要换一个语境，不能直接复用看词例句。',
        );
        validateMiniWritingLinks(state, item.focusIds, item.sentence.word);
      }
      day.writingPrompts = [
        ...prompts,
        ...action.prompts.map((item) => ({ ...item, createdAt: at })),
      ];
      return;
    }
    if (action.type === 'record_feedback' || action.type === 'qualitative_feedback') {
      const attempt = day.flow
        ? day.translation.find((item) => item.id.toLowerCase() === action.attemptId.toLowerCase())
        : currentAttempt(day);
      check(
        !!attempt &&
          attempt.id.toLowerCase() === action.attemptId.toLowerCase() &&
          !attempt.feedback,
      );
      attempt.feedback = action.feedback;
      attempt.gradedAt = at;
      // Qualitative AI feedback is teaching evidence, never a scheduling input.
      return;
    }
    check(
      (!day.paused || action.type === 'complete_review' || action.type === 'complete_learning') &&
        day.phase !== 'finished',
      '任务已暂停或完成，请先继续当前任务。',
    );
    switch (action.type) {
      case 'window_choose':
      case 'window_correct':
      case 'window_advance':
      case 'window_draft':
        applyMiniWindowAction(day, action, at);
        return;
      case 'memory_advance':
      case 'memory_reveal':
      case 'memory_draft': {
        const memory = day.memory;
        check(
          day.phase === 'learning' &&
            !!memory &&
            memory.round <= 3 &&
            memory.round === action.round &&
            sameWord(memory.queue[0], action.word),
        );
        check(
          day.sentences.some((sentence) => sameWord(sentence.word, action.word)),
          '请先准备当前词的例句。',
        );
        if (action.draft !== undefined)
          memoryDraft(memory, action.word, action.round, action.draft, at);
        if (action.type === 'memory_draft') return;
        if (action.type === 'memory_reveal') {
          memory.reveals.push({
            word: action.word,
            round: action.round,
            at,
            beforeEventCount: memory.events.length,
          });
          memory.revealed = true;
          return;
        }
        memory.events.push({
          id: randomUUID(),
          word: action.word,
          round: action.round,
          remembered: action.remembered,
          at,
        });
        advanceMemory(memory, action.word, action.remembered);
        if (action.round === 3 && action.remembered)
          day.studiedWords.push({ word: action.word, at });
        return;
      }
      case 'memory_undo': {
        const memory = day.memory;
        check(day.phase === 'learning' && !!memory && day.learning?.spellingAttempts.length === 0);
        const event = lastWhere(memory.events, (item) => item.undoneAt === undefined);
        check(!!event, '当前没有可撤销的记忆进度。');
        event.undoneAt = at;
        const replayed = replayMemory(day.learningWords, memory.events);
        Object.assign(memory, {
          round: replayed.round,
          queue: replayed.queue,
          progress: replayed.progress,
          revealed: false,
        });
        day.studiedWords = memory.events
          .filter((item) => item.undoneAt === undefined && item.round === 3 && item.remembered)
          .map((item) => ({ word: item.word, at: item.at }));
        return;
      }
      case 'complete_review': {
        check(day.phase === 'review' && day.review?.phase === 'finished');
        if (day.flow) {
          day.reviewFinishedAt = at;
          beginMiniFlowLearning(day, at);
          return;
        }
        for (const [index, word] of day.reviewWords.entries()) {
          const judgment = day?.review?.judgmentEvents.find((item) =>
            sameWord(item.word, word),
          )?.final;
          const first = day?.review?.spellingAttempts.find(
            (item) => sameWord(item.word, word) && item.kind === 'first',
          );
          const promoted = Math.min(Math.max(day?.reviewSteps[index] ?? 0, 0), 3) + 1;
          schedule(
            day,
            word,
            judgment === 'clear' &&
              first?.correct === true &&
              first.lastPotentialHelpAt === undefined
              ? promoted
              : 0,
            'review',
            at,
            timezone,
          );
        }
        day.reviewFinishedAt = at;
        if (day.writingRequired === false) {
          day.phase = 'finished';
          day.finishedAt = at;
          return;
        }
        if (day.learning) {
          day.phase = 'learning';
          day.learningStartedAt = at;
        } else beginTranslation(day, at);
        return;
      }
      case 'mark_studied': {
        check(day.memory === undefined, '请完成三轮记忆，再开始总拼写。');
        const next = day.learningWords.find(
          (word) => !day?.studiedWords.some((item) => sameWord(item.word, word)),
        );
        check(
          day.phase === 'learning' &&
            day.retainedLearningWord === undefined &&
            sameWord(next, action.word) &&
            day.sentences.some((item) => sameWord(item.word, action.word)),
        );
        day.studiedWords.push({ word: action.word, at });
        return;
      }
      case 'complete_learning':
        if (day.flow) {
          check(day.phase === 'learning' && day.learning?.phase === 'finished');
          day.learningFinishedAt = at;
          beginTranslation(day, at);
          return;
        }
        check(
          day.phase === 'learning' &&
            (day.memory === undefined || day.memory.round === 4) &&
            day.learning?.phase === 'finished' &&
            day.learningWords.every((word) =>
              day?.studiedWords.some((item) => sameWord(item.word, word)),
            ),
        );
        for (const word of day.learningWords) {
          const first = day.learning.spellingAttempts.find(
            (item) => sameWord(item.word, word) && item.kind === 'first',
          );
          schedule(
            day,
            word,
            0,
            'learning',
            at,
            timezone,
            first?.correct === true && first.lastPotentialHelpAt === undefined ? 2 : 1,
          );
        }
        day.learningFinishedAt = at;
        beginTranslation(day, at);
        return;
      case 'translation_draft':
        check(currentTranslation(day)?.id === action.taskId && !currentAttempt(day));
        day.translationDraft = action.draft;
        return;
      case 'submit_translation': {
        const task = currentTranslation(day);
        check(
          !!task &&
            task.id === action.taskId &&
            !currentAttempt(day) &&
            action.answer.trim().length > 0,
        );
        day.translation.push({ id: randomUUID(), task, answer: action.answer, submittedAt: at });
        day.translationDraft = '';
        return;
      }
      case 'advance_translation':
        if (day.flow) {
          const attempt = currentAttempt(day);
          check(
            currentTranslation(day)?.id === action.taskId &&
              !!attempt &&
              attempt.confirmedAt === undefined,
          );
          attempt.confirmedAt = at;
          day.flow.completed.push({
            word: attempt.task.sentence.word,
            attemptId: attempt.id.toLowerCase(),
            at,
            date: localDay(unixDate(at), day.timezone ?? timezone),
          });
          day.translationIndex += 1;
          if (day.translationIndex === day.flow.translationWords.length)
            finishMiniFlowGroup(day, at);
          return;
        }
        check(currentTranslation(day)?.id === action.taskId && !!currentAttempt(day)?.feedback);
        day.translationIndex += 1;
        if (day.translationIndex === day.reviewWords.length + day.learningWords.length) {
          day.phase = 'finished';
          day.finishedAt = at;
        }
        return;
      case 'continue_to_learning':
        invalid();
    }
  } else {
    const record = state.reviewRecord;
    check(!!record && record.id.toLowerCase() === action.recordId?.toLowerCase());
    if (action.type === 'pause') {
      check(record.session.phase !== 'finished');
      record.paused = action.paused;
      return;
    }
    if (action.type === 'continue_to_learning') {
      check(record.session.phase === 'finished');
      record.continuedToLearning = true;
      return;
    }
    check(!record.paused, '复习已暂停，请先继续。');
  }
  const session = day
    ? action.session === 'review'
      ? day.review
      : action.session === 'learning'
        ? day.learning
        : undefined
    : state.reviewRecord?.session;
  check(!!session);
  if (day)
    check(
      (action.session === 'review' && day.phase === 'review') ||
        (action.session === 'learning' &&
          day.phase === 'learning' &&
          day.retainedLearningWord === undefined &&
          (day.memory === undefined || day.memory.round === 4) &&
          (day.flow ? day.flow.groupWords : day.learningWords).every((word) =>
            day?.studiedWords.some((item) => sameWord(item.word, word)),
          )),
    );
  switch (action.type) {
    case 'choose_judgment':
      check(sameWord(session.queue[0], action.word));
      chooseJudgment(session, action.judgment, at);
      return;
    case 'advance_judgment':
      check(sameWord(session.queue[0], action.word));
      advanceJudgment(session, action.markWrong, at);
      return;
    case 'spelling_draft':
      check(session.phase === 'spelling' && sameWord(session.queue[0], action.word));
      session.spellingDraft = action.draft;
      return;
    case 'submit_spelling':
      check(sameWord(session.queue[0], action.word));
      {
        const helpful = state.teaching.exposures.filter(
          (item) =>
            item.beforeAttemptCount <= session.spellingAttempts.length &&
            item.at <= at &&
            sameWord(item.word, action.word) &&
            (day
              ? item.dayId === day.id && item.session === action.session
              : item.recordId === state.reviewRecord?.id),
        );
        const answerRevealAt = helpful
          .filter((item) => item.kind === 'answerReveal')
          .reduce<number | undefined>(
            (latest, item) => (latest === undefined ? item.at : Math.max(latest, item.at)),
            undefined,
          );
        const potentialHelpAt = helpful.reduce<number | undefined>(
          (latest, item) => (latest === undefined ? item.at : Math.max(latest, item.at)),
          undefined,
        );
        submitSpelling(session, action.answer, at, { answerRevealAt, potentialHelpAt });
      }
      if (
        action.advanceOnCorrect &&
        session.spellingPolicy !== 'retry-errors-v2' &&
        session.spellingState === 'readyToAdvance'
      )
        advanceSpelling(session);
      else if (session.spellingState === 'skipped' && session.spellingPolicy !== 'retry-errors-v2')
        advanceSpelling(session);
      return;
    case 'advance_spelling':
      check(sameWord(session.queue[0], action.word));
      advanceSpelling(session);
      return;
    default:
      invalid();
  }
}

/** Validate decoded legacy facts without completing, grading, or inventing missing events. */
export function validateMiniFacts(snapshot: MiniSnapshot): void {
  const validSession = (session: MiniReviewSession) => {
    check(
      unique(session.words).length === session.words.length &&
        unique(session.queue).length === session.queue.length,
      '复习记录包含重复目标。',
    );
    check(
      session.queue.every((word) => session.words.some((item) => sameWord(item, word))),
      '复习队列包含未知目标。',
    );
    check(
      (session.phase === 'finished' ||
        (session.phase === 'judgment' && session.relearning !== undefined)) ===
        (session.queue.length === 0),
      '复习阶段与队列不一致。',
    );
    check(
      session.judgmentEvents.every(
        (item) =>
          session.words.some((word) => sameWord(word, item.word)) &&
          (item.final === undefined) === (item.finalizedAt === undefined),
      ),
      '自评记录不完整。',
    );
    check(
      session.judgmentEvents.filter((item) => item.final === undefined).length <= 1,
      '存在多条未完成自评。',
    );
    for (const item of session.spellingAttempts) {
      check(
        session.words.some((word) => sameWord(word, item.word)) &&
          item.answer.trim().length > 0 &&
          item.correct === (item.answer.trim().toLowerCase() === item.word.spelling.toLowerCase()),
        '拼写事实与原答不一致。',
      );
      check(
        item.revealedAnswerAt === undefined ||
          (item.kind === 'first' && !item.correct && item.revealedAnswerAt === item.submittedAt),
        '答案揭晓记录不一致。',
      );
    }
    if (session.phase === 'judgment')
      check(session.spellingAttempts.length === 0, '拼写事实不能出现在自评阶段。');
    if (session.spellingState !== 'awaitingFirst')
      check(
        session.phase === 'spelling' &&
          sameWord(session.spellingAttempts.at(-1)?.word, session.queue[0]) &&
          session.spellingAttempts.at(-1)?.correct === (session.spellingState === 'readyToAdvance'),
        '拼写状态缺少原答。',
      );
    // Reconstruct the queue solely from original events. A serialized status cannot invent a pass.
    const replayed = makeReview(
      session.words,
      session.fullBatchSpelling === true,
      session.spellingPolicy === 'retry-errors-v1',
      session.spellingPolicy === 'retry-errors-v2',
    );
    for (const event of session.judgmentEvents) {
      check(sameWord(replayed.queue[0], event.word), '自评事实与当前目标不一致。');
      chooseJudgment(replayed, event.selected, event.selectedAt);
      if (event.final !== undefined && event.finalizedAt !== undefined)
        advanceJudgment(replayed, event.final !== event.selected, event.finalizedAt);
    }
    if (session.spellingPolicy === 'retry-errors-v2') {
      check(
        JSON.stringify(replayed.relearningWords ?? []) ===
          JSON.stringify(session.relearningWords ?? []),
        '复习重学目标缺少三轮判断事实。',
      );
      check(
        (replayed.relearning === undefined) === (session.relearning === undefined),
        '复习重学状态缺失。',
      );
      if (session.relearning) {
        validateMiniWindow(session.relearning, session.relearningWords ?? []);
        const completed = new Set(
          session.relearning.events
            .filter((event) => event.remembered && event.stage === 2)
            .map((event) => wordKey(event.word)),
        );
        const outstanding = (session.relearningWords ?? []).filter(
          (word) => !completed.has(wordKey(word)),
        );
        check(
          JSON.stringify(outstanding.slice(0, session.relearning.size).map(wordKey)) ===
            JSON.stringify(session.relearning.members.map((member) => wordKey(member.word))),
          '重学不能丢弃窗口内尚未通过的词。',
        );
        replayed.relearning = structuredClone(session.relearning);
        if (outstanding.length === 0) {
          check(
            session.relearning.members.length === 0 && session.relearning.visit === null,
            '重学结束队列不一致。',
          );
          replayed.phase = 'spelling';
          replayed.queue = [...session.words];
        } else
          check(
            session.relearning.members.length > 0 && session.relearning.visit !== null,
            '重学不能跳过未完成词。',
          );
      }
      replayed.relearningWords = session.relearningWords;
    }
    for (const attempt of session.spellingAttempts) {
      if (replayed.spellingState === 'readyToAdvance' || replayed.spellingState === 'skipped')
        advanceSpelling(replayed);
      check(sameWord(replayed.queue[0], attempt.word), '拼写事实与当前目标不一致。');
      submitSpelling(replayed, attempt.answer, attempt.submittedAt, {
        answerRevealAt: attempt.lastAnswerRevealAt,
        potentialHelpAt: attempt.lastPotentialHelpAt,
      });
    }
    if (
      (replayed.spellingState === 'skipped' &&
        (session.spellingPolicy !== 'retry-errors-v2' ||
          session.spellingState === 'awaitingFirst' ||
          session.phase === 'finished')) ||
      (replayed.spellingState === 'readyToAdvance' &&
        (session.phase === 'finished' || session.spellingState === 'awaitingFirst'))
    )
      advanceSpelling(replayed);
    replayed.spellingDraft = session.spellingDraft;
    // Legacy JSON can encode an explicit false as well as omit this optional flag.
    replayed.fullBatchSpelling = session.fullBatchSpelling;
    replayed.clearedJudgments = session.clearedJudgments;
    check(
      JSON.stringify(miniReviewSessionSchema.parse(replayed)) ===
        JSON.stringify(miniReviewSessionSchema.parse(session)),
      '复习状态与保存的原始事实不一致。',
    );
  };
  const ids = new Set<string>();
  const materialIds = new Set<string>();
  let unfinished = 0;
  for (const day of snapshot.ledger.days) {
    check(!ids.has(day.id), '每日记录身份重复。');
    ids.add(day.id);
    if (day.phase !== 'finished' && !day.paused) unfinished += 1;
    const words = [...day.reviewWords, ...day.learningWords];
    if (day.flow) {
      validateMiniFlowDay(day, validSession);
      check(new Set(words.map(wordKey)).size === words.length, '每日目标包含重复词。');
      const targets = miniWritingWords(day);
      const prompts = day.writingPrompts ?? [];
      check(
        new Set(prompts.map((item) => wordKey(item.sentence.word))).size === prompts.length,
        '新版写作目标重复。',
      );
      for (const prompt of prompts) {
        check(!materialIds.has(prompt.id), '写作材料身份跨组重复。');
        materialIds.add(prompt.id);
        const index = targets.findIndex((word) => sameWord(word, prompt.sentence.word));
        check(
          index >= 0 &&
            day.directions[index] === prompt.direction &&
            prompt.sentence.english.trim().length > 0 &&
            prompt.sentence.chinese.trim().length > 0 &&
            new Set(prompt.focusIds).size === prompt.focusIds.length &&
            prompt.focusIds.every((id) => stateFocusExists(snapshot, id, prompt.sentence.word)),
          '新版写作材料关联无效。',
        );
      }
      continue;
    }
    if (day.memory) {
      const memory = day.memory;
      const replayed = replayMemory(day.learningWords, memory.events);
      check(
        new Set(memory.events.map((event) => event.id)).size === memory.events.length,
        '记忆事件身份重复。',
      );
      check(
        memory.events.every(
          (event) =>
            day.learningWords.some((word) => sameWord(word, event.word)) &&
            (event.undoneAt === undefined || event.undoneAt >= event.at),
        ),
        '记忆事件关联或时间无效。',
      );
      check(
        memory.round === replayed.round &&
          JSON.stringify(memory.queue) === JSON.stringify(replayed.queue) &&
          JSON.stringify(memory.progress) === JSON.stringify(replayed.progress),
        '记忆进度与真实轮次不一致。',
      );
      const marks = memory.events
        .filter((event) => event.undoneAt === undefined && event.round === 3 && event.remembered)
        .map((event) => ({ word: event.word, at: event.at }));
      check(
        JSON.stringify(day.studiedWords) === JSON.stringify(marks),
        '待拼写标记必须来自第三轮自评。',
      );
      check(
        day.learning?.spellingPolicy === 'retry-errors-v1' &&
          (memory.round === 4 || day.learning.spellingAttempts.length === 0),
        '总拼写须等待三轮记忆完成。',
      );
      check(
        memory.drafts.every((draft) =>
          day.learningWords.some((word) => sameWord(word, draft.word)),
        ) &&
          new Set(memory.drafts.map((draft) => JSON.stringify([wordKey(draft.word), draft.round])))
            .size === memory.drafts.length,
        '记忆草稿关联重复或无效。',
      );
      check(
        memory.reveals.every(
          (reveal) =>
            day.learningWords.some((word) => sameWord(word, reveal.word)) &&
            reveal.beforeEventCount <= memory.events.length,
        ),
        '记忆揭晓关联无效。',
      );
      check(
        !memory.revealed ||
          memory.reveals.some(
            (reveal) =>
              reveal.round === memory.round &&
              sameWord(reveal.word, memory.queue[0]) &&
              reveal.beforeEventCount === memory.events.length,
          ),
        '当前揭晓缺少真实记录。',
      );
    }
    check(
      new Set(words.map(wordKey)).size === words.length &&
        day.reviewSteps.length === day.reviewWords.length &&
        day.directions.length === words.length,
      '每日目标和调度记录不一致。',
    );
    check(
      day.translationIndex <= words.length &&
        day.translation.length <= words.length &&
        day.translationIndex <= day.translation.length,
      '翻译进度不一致。',
    );
    check(
      day.reviewWords.length > 0 === !!day.review &&
        day.learningWords.length > 0 === !!day.learning,
      '每日复习或学习会话缺失。',
    );
    for (const [session, targets] of [
      [day.review, day.reviewWords],
      [day.learning, day.learningWords],
    ] as const)
      if (session) {
        validSession(session);
        check(
          session.words.length === targets.length &&
            session.words.every((word, index) => sameWord(word, targets[index])),
          '会话目标与每日目标不一致。',
        );
      }
    check(
      unique(day.sentences.map((item) => item.word)).length === day.sentences.length &&
        day.sentences.every(
          (item) =>
            words.some((word) => sameWord(word, item.word)) &&
            item.english.trim().length > 0 &&
            item.chinese.trim().length > 0,
        ),
      '例句关联无效。',
    );
    const prompts = day.writingPrompts ?? [];
    for (const prompt of prompts) {
      check(!materialIds.has(prompt.id), '写作材料身份跨组重复。');
      materialIds.add(prompt.id);
    }
    check(
      new Set(prompts.map((item) => item.id)).size === prompts.length &&
        new Set(prompts.map((item) => wordKey(item.sentence.word))).size === prompts.length &&
        prompts.every((item) => {
          const index = words.findIndex((word) => sameWord(word, item.sentence.word));
          return (
            index >= 0 &&
            day.directions[index] === item.direction &&
            item.sentence.english.trim().length > 0 &&
            item.sentence.chinese.trim().length > 0 &&
            new Set(item.focusIds).size === item.focusIds.length &&
            item.focusIds.every((id) => stateFocusExists(snapshot, id, item.sentence.word))
          );
        }),
      '写作材料关联无效。',
    );
    check(
      day.studiedWords.length <= day.learningWords.length &&
        new Set(day.studiedWords.map((item) => wordKey(item.word))).size ===
          day.studiedWords.length &&
        day.studiedWords.every(
          (item, index) =>
            (day.memory
              ? day.learningWords.some((word) => sameWord(word, item.word))
              : sameWord(item.word, day.learningWords[index])) &&
            day.sentences.some((sentence) => sameWord(sentence.word, item.word)),
        ),
      '新词学习曝光记录不一致。',
    );
    const attemptIds = new Set<string>();
    day.translation.forEach((attempt, index) => {
      check(!attemptIds.has(attempt.id.toLowerCase()), '翻译作答身份重复。');
      attemptIds.add(attempt.id.toLowerCase());
      check(
        attempt.task.id === `${day.id}/${index}` &&
          sameWord(attempt.task.sentence.word, words[index]) &&
          attempt.task.direction === day.directions[index] &&
          (attempt.task.materialId !== undefined
            ? prompts.some(
                (prompt) =>
                  prompt.id === attempt.task.materialId &&
                  prompt.direction === attempt.task.direction &&
                  sameWord(prompt.sentence.word, attempt.task.sentence.word) &&
                  prompt.sentence.english === attempt.task.sentence.english &&
                  prompt.sentence.chinese === attempt.task.sentence.chinese &&
                  JSON.stringify(prompt.focusIds) === JSON.stringify(attempt.task.focusIds),
              )
            : day.sentences.some(
                (sentence) =>
                  sameWord(sentence.word, attempt.task.sentence.word) &&
                  sentence.english === attempt.task.sentence.english &&
                  sentence.chinese === attempt.task.sentence.chinese,
              )),
        '翻译题目与学习目标不一致。',
      );
      check(
        attempt.answer.trim().length > 0 &&
          (attempt.feedback === undefined) === (attempt.gradedAt === undefined) &&
          (index >= day.translationIndex || !!attempt.feedback),
        '翻译原答或反馈缺失。',
      );
    });
    check(
      day.scheduleUpdates.every((item) => words.some((word) => sameWord(word, item.word))),
      '调度记录关联无效。',
    );
    if (day.phase === 'review')
      check(day.reviewWords.length > 0 && day.translation.length === 0, '每日阶段不一致。');
    if (day.phase === 'learning')
      check(
        day.learningWords.length > 0 &&
          day.translation.length === 0 &&
          day.learningStartedAt !== undefined,
        '每日阶段不一致。',
      );
    if (day.phase !== 'review' && day.reviewWords.length > 0)
      check(
        day.review?.phase === 'finished' &&
          day.reviewFinishedAt !== undefined &&
          day.reviewWords.every((word) =>
            day.scheduleUpdates.some(
              (item) => item.source === 'review' && sameWord(item.word, word),
            ),
          ),
        '后续阶段缺少已完成复习事实。',
      );
    check(
      day.writingRequired !== false || day.learningWords.length === 0,
      '仅复习组不能包含新词。',
    );
    if (
      (day.phase === 'translation' ||
        (day.phase === 'finished' && day.writingRequired !== false)) &&
      words.length > 0
    ) {
      check(day.translationStartedAt !== undefined, '缺少写作阶段开始记录。');
      if (day.learningWords.length > 0)
        check(
          day.learning?.phase === 'finished' &&
            day.learningFinishedAt !== undefined &&
            day.studiedWords.length === day.learningWords.length &&
            day.learningWords.every((word) =>
              day.scheduleUpdates.some(
                (item) => item.source === 'learning' && sameWord(item.word, word),
              ),
            ),
          '写作阶段缺少已完成学习事实。',
        );
    }
    if (day.phase === 'translation')
      check(day.translationIndex < words.length, '写作阶段已经超出最后一题。');
    check(day.translation.length <= day.translationIndex + 1, '不能预先提交后续题目。');
    if (day.phase === 'finished')
      check(
        day.finishedAt !== undefined &&
          (words.length === 0 ||
            (day.writingRequired === false &&
              day.review?.phase === 'finished' &&
              day.translation.length === 0) ||
            (day.translationIndex === words.length &&
              day.translation.every((attempt) => !!attempt.feedback))),
        '已完成每日记录缺少翻译事实。',
      );
  }
  check(unfinished <= 1, '有多个未暂停的学习组。');
  if (snapshot.reviewRecord) validSession(snapshot.reviewRecord.session);
  const historyIds = new Set<string>();
  for (const record of snapshot.reviewHistory) {
    validSession(record.session);
    check(!historyIds.has(record.id.toLowerCase()), '旧复习归档身份重复。');
    historyIds.add(record.id.toLowerCase());
  }
}
