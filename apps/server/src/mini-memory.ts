import {
  miniMemoryOverviewInputSchema,
  miniMemoryOverviewSchema,
  miniMemoryDetailInputSchema,
  miniMemoryDetailSchema,
  type MiniMemoryOverviewInput,
  type MiniMemoryDetailInput,
  type MiniMemoryWord,
  type MiniMemoryDetail,
  type MiniSnapshot,
  type MiniWord,
  type MiniFlowScheduleCard,
} from '@lingoweave/contracts';
import { LearningError } from './learning-store.js';
import { flowMemoryHistory, flowRetrievability, flowSenseId } from './mini-flow-scheduler.js';
import {
  isMiniDayOnDate,
  localDay,
  miniReviewAvailability,
  swiftTime,
  wordKey,
} from './mini-study.js';
import { miniCompletedWordKeys } from './mini-vocabulary-store.js';

const epoch = 978307200;
const dateAt = (at: number) => new Date((at + epoch) * 1000);
const estimation = {
  model: 'FSRS-6',
  label: 'estimated',
  futureAssumption: 'no-additional-reviews',
  historyBasis: 'current-saved-evidence',
} as const;
type Ability = MiniFlowScheduleCard['meaning'];
type Event = MiniMemoryDetail['events'][number];
type History = {
  marker?: boolean;
  event: Event;
  meaning: Ability;
  spelling: Ability;
  weights?: readonly number[];
};
function projectedAbility(card: Ability, at: number, weights?: readonly number[]) {
  const retrievability = flowRetrievability(card, at, weights);
  if (retrievability === null || !card || card.last_review === undefined) return null;
  return {
    retrievability,
    stability: card.stability,
    difficulty: card.difficulty,
    lastReviewAt: card.last_review,
    reps: card.reps,
    lapses: card.lapses,
  };
}
function maximum(values: (number | null | undefined)[]): number | null {
  const present = values.filter((value): value is number => value !== null && value !== undefined);
  return present.length ? Math.max(...present) : null;
}
export function miniSavedReviewVisits(snapshot: MiniSnapshot) {
  const visits = new Map<string, { word: MiniWord; ids: Set<string>; latest: number | null }>();
  function visit(word: MiniWord, id: string, at: number | null) {
    const key = wordKey(word);
    const item = visits.get(key) ?? { word, ids: new Set<string>(), latest: null };
    item.ids.add(id);
    item.latest = maximum([item.latest, at]);
    visits.set(key, item);
  }
  for (const event of snapshot.scheduling.flow.events)
    if (event.kind === 'review' || event.kind === 'probe')
      visit(event.word, event.sourceId, event.occurredAt);
  for (const day of snapshot.ledger.days)
    if (day.reviewFinishedAt !== undefined)
      for (const word of day.reviewWords) visit(word, day.id, day.reviewFinishedAt);
  for (const record of [snapshot.reviewRecord, ...snapshot.reviewHistory]) {
    if (record?.session.phase !== 'finished') continue;
    for (const event of record.session.judgmentEvents)
      visit(event.word, record.id, event.finalizedAt ?? event.selectedAt);
    for (const attempt of record.session.spellingAttempts)
      visit(attempt.word, record.id, attempt.submittedAt);
  }
  for (const probe of snapshot.scheduling.probes)
    if (probe.rating && probe.submittedAt !== undefined)
      visit(probe.word, probe.id, probe.submittedAt);
  return visits;
}
function indexedWords(snapshot: MiniSnapshot, asOf: number, timezone: string) {
  const date = localDay(dateAt(asOf), timezone);
  const {
    words: targets,
    schedules,
    outstanding,
    inReviewGroup,
  } = miniReviewAvailability(snapshot, asOf, date);
  const learned = miniCompletedWordKeys(snapshot.ledger);
  const currentLearning = new Set<string>();
  const priorLearning = new Set<string>();
  const firstEvents = new Map<string, number>();
  const visits = miniSavedReviewVisits(snapshot);
  for (const event of snapshot.scheduling.flow.events) {
    const key = wordKey(event.word);
    firstEvents.set(key, Math.min(firstEvents.get(key) ?? Infinity, event.occurredAt));
    if (event.kind === 'completion') learned.add(key);
  }
  for (const day of snapshot.ledger.days) {
    const set =
      day.phase !== 'finished' && isMiniDayOnDate(day, date) ? currentLearning : priorLearning;
    for (const word of day.learningWords) set.add(wordKey(word));
  }

  const flow = new Map(snapshot.scheduling.flow.cards.map((card) => [wordKey(card.word), card]));
  const legacy = new Map(snapshot.scheduling.cards.map((card) => [wordKey(card.word), card]));
  const words: MiniMemoryWord[] = [];
  let excludedLegacyCount = 0;
  for (const word of targets) {
    const key = wordKey(word),
      card = flow.get(key),
      old = legacy.get(key);
    const scheduled = schedules.get(key);
    const meaning = projectedAbility(card?.meaning ?? null, asOf);
    const spelling = card
      ? projectedAbility(card.spelling, asOf)
      : projectedAbility(old?.fsrs ?? null, asOf, snapshot.scheduling.parameters.weights);
    if (
      !scheduled &&
      !outstanding.has(key) &&
      !currentLearning.has(key) &&
      !learned.has(key) &&
      !meaning &&
      !spelling &&
      !visits.has(key)
    ) {
      if (old && !priorLearning.has(key)) excludedLegacyCount++;
      continue;
    }
    const firstSeen = Math.min(firstEvents.get(key) ?? Infinity, old?.introducedAt ?? Infinity);
    const review = visits.get(key);
    words.push({
      senseId: flowSenseId(word),
      word,
      source: card || (!old?.fsrs && !scheduled && currentLearning.has(key)) ? 'flow' : 'legacy',
      status: outstanding.has(key)
        ? 'due'
        : scheduled
          ? 'scheduled'
          : currentLearning.has(key)
            ? 'learning'
            : 'unmeasured',
      ...(inReviewGroup.has(key) ? { inCurrentReview: true } : {}),
      dueAt: scheduled?.dueAt ?? null,
      idealDueAt: scheduled ? (card?.idealDueAt ?? old?.fsrs?.due ?? null) : null,
      firstSeenAt: Number.isFinite(firstSeen) ? firstSeen : null,
      lastReviewAt: review?.latest ?? null,
      reviewCount: review?.ids.size ?? 0,
      meaning,
      spelling,
    });
  }
  words.sort(
    (a, b) =>
      (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) ||
      a.word.spelling.localeCompare(b.word.spelling) ||
      a.senseId.localeCompare(b.senseId),
  );
  return { words, completedWordCount: learned.size, excludedLegacyCount };
}
function notices(excludedLegacyCount: number) {
  return [
    '曲线是 FSRS-6 连续模型估计，不是实测记忆率；到期日另受次日复习、保守上限和错峰规则约束。',
    ...(excludedLegacyCount
      ? [`${excludedLegacyCount} 个旧记录尚无可用的 FSRS 状态或参数，暂不绘制曲线。`]
      : []),
  ];
}
function calendar(timezone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const day = (at: number) => formatter.format(dateAt(at));
  function start(value: string) {
    const estimate = swiftTime(new Date(`${value}T12:00:00Z`));
    let low = estimate - 48 * 3600,
      high = estimate + 24 * 3600;
    for (let step = 0; step < 40; step++) {
      const middle = (low + high) / 2;
      if (day(middle) >= value) high = middle;
      else low = middle;
    }
    return Math.ceil(high);
  }
  return { day, start };
}
export function memoryOverview(
  snapshot: MiniSnapshot,
  raw: MiniMemoryOverviewInput,
  asOf = swiftTime(new Date()),
) {
  const input = miniMemoryOverviewInputSchema.parse(raw);
  const { words, completedWordCount, excludedLegacyCount } = indexedWords(
    snapshot,
    asOf,
    input.timezone,
  );
  const dates = calendar(input.timezone);
  const loads = new Map<string, number>();
  const firstDay = dates.day(input.from),
    lastDay = dates.day(input.to),
    today = dates.day(asOf);
  let overdueCount = 0;
  for (const word of words) {
    if (word.dueAt === null) continue;
    const day = dates.day(word.dueAt);
    if (word.status === 'due' && day < today) overdueCount++;
    if (firstDay <= day && day <= lastDay) loads.set(day, (loads.get(day) ?? 0) + 1);
  }
  return miniMemoryOverviewSchema.parse({
    schemaVersion: 1,
    revision: snapshot.revision,
    asOf,
    ...input,
    estimation,
    notices: notices(excludedLegacyCount),
    words,
    summary: {
      wordCount: words.length,
      completedWordCount,
      excludedLegacyCount,
      measuredWordCount: words.filter((word) => word.meaning || word.spelling).length,
      overdueCount,
      dueCount: words.filter((word) => word.status === 'due').length,
      scheduledCount: words.filter((word) => word.status === 'scheduled').length,
      learningCount: words.filter((word) => word.status === 'learning').length,
    },
    load: [...loads]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, count]) => ({ day, at: dates.start(day), count })),
  });
}
function eventView(event: Event): Event {
  return {
    id: event.id,
    kind: event.kind,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    evidence: event.evidence,
    meaning: event.meaning,
    spelling: event.spelling,
    reasons: [...event.reasons],
  };
}
function wordHistory(snapshot: MiniSnapshot, row: MiniMemoryWord): History[] {
  if (row.source === 'flow') return flowMemoryHistory(snapshot, row.word);
  const entries: History[] = [];
  const card = snapshot.scheduling.cards.find((item) => flowSenseId(item.word) === row.senseId);
  for (const probe of snapshot.scheduling.probes) {
    if (flowSenseId(probe.word) !== row.senseId || probe.submittedAt === undefined) continue;
    const weights = probe.parameters?.weights ?? snapshot.scheduling.parameters.weights;
    if (probe.scheduleAfter)
      entries.push({
        event: {
          id: probe.id,
          kind: 'probe',
          occurredAt: probe.submittedAt,
          recordedAt: probe.submittedAt,
          evidence: 'objective',
          meaning: null,
          spelling: probe.rating ?? null,
          reasons: probe.reason ? [probe.reason] : [],
        },
        meaning: null,
        spelling: probe.scheduleAfter,
        weights,
      });
  }
  // A saved current legacy card can support estimates from its last review onward;
  // it cannot reconstruct earlier states that were never retained.
  if (
    card?.fsrs?.last_review !== undefined &&
    !entries.some((entry) => entry.spelling?.last_review === card.fsrs?.last_review)
  )
    entries.push({
      marker: false,
      event: {
        id: `legacy-state/${row.senseId}`,
        kind: 'probe',
        occurredAt: card.fsrs.last_review,
        recordedAt: card.fsrs.last_review,
        evidence: 'objective',
        meaning: null,
        spelling: null,
        reasons: ['仅保存了此时的旧版能力状态；没有补造原始作答评级。'],
      },
      meaning: null,
      spelling: card.fsrs,
      weights: snapshot.scheduling.parameters.weights,
    });
  return entries.sort(
    (a, b) => a.event.occurredAt - b.event.occurredAt || a.event.id.localeCompare(b.event.id),
  );
}
function chooseEvenly<T>(values: readonly T[], limit: number): T[] {
  if (values.length <= limit) return [...values];
  const result: T[] = [];
  for (let index = 0; index < limit; index++) {
    const item = values[Math.round((index * (values.length - 1)) / (limit - 1))];
    if (item !== undefined) result.push(item);
  }
  return result;
}
export function memoryDetail(
  snapshot: MiniSnapshot,
  raw: MiniMemoryDetailInput,
  asOf = swiftTime(new Date()),
) {
  const input = miniMemoryDetailInputSchema.parse(raw);
  const indexed = indexedWords(snapshot, asOf, input.timezone);
  const word = indexed.words.find((item) => item.senseId === input.senseId);
  if (!word)
    throw new LearningError('MINI_MEMORY_NOT_FOUND', '没有可显示的这个词的记忆记录。', 404);
  const history = wordHistory(snapshot, word).filter((entry) => entry.event.occurredAt <= asOf);
  const transitions = history.filter((entry, index) => {
    const previous = history[index - 1];
    return (
      entry.event.occurredAt >= input.from &&
      entry.event.occurredAt <= input.to &&
      (entry.meaning?.reps !== previous?.meaning?.reps ||
        entry.spelling?.reps !== previous?.spelling?.reps)
    );
  });
  const times = new Set<number>();
  for (let index = 0; index < 240; index++)
    times.add(input.from + ((input.to - input.from) * index) / 239);
  if (asOf >= input.from && asOf <= input.to) times.add(asOf);
  for (const entry of chooseEvenly(transitions, 28)) {
    times.add(entry.event.occurredAt);
    if (entry.event.occurredAt - 0.001 >= input.from) times.add(entry.event.occurredAt - 0.001);
  }
  let cursor = -1;
  const points = [...times]
    .sort((a, b) => a - b)
    .map((at) => {
      while (true) {
        const next = history[cursor + 1];
        if (!next || next.event.occurredAt > Math.min(at, asOf)) break;
        cursor++;
      }
      const entry = history[cursor];
      const meaning = flowRetrievability(entry?.meaning, at, entry?.weights);
      const spelling = flowRetrievability(entry?.spelling, at, entry?.weights);
      return {
        at,
        meaning,
        spelling,
        meaningSegment:
          meaning === null
            ? null
            : `meaning/${entry?.meaning?.last_review}/${entry?.meaning?.reps}`,
        spellingSegment:
          spelling === null
            ? null
            : `spelling/${entry?.spelling?.last_review}/${entry?.spelling?.reps}`,
        projected: at > asOf,
      };
    });
  const visibleEvents = history
    .filter((entry) => entry.marker !== false)
    .map((entry) => entry.event)
    .filter(
      (event) =>
        (event.occurredAt >= input.from && event.occurredAt <= input.to) ||
        (event.recordedAt >= input.from && event.recordedAt <= input.to),
    );
  return miniMemoryDetailSchema.parse({
    schemaVersion: 1,
    revision: snapshot.revision,
    asOf,
    timezone: input.timezone,
    from: input.from,
    to: input.to,
    estimation,
    notices: notices(indexed.excludedLegacyCount),
    word,
    points,
    events: visibleEvents.slice(-500).map(eventView),
    downsampled: transitions.length > 28,
    eventsTruncated: visibleEvents.length > 500,
  });
}
