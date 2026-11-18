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
import { swiftTime } from './mini-study.js';

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
function indexedWords(snapshot: MiniSnapshot, asOf: number) {
  const legacy = new Map(snapshot.scheduling.cards.map((card) => [flowSenseId(card.word), card]));
  const facts = new Map<string, { first: number; completed: boolean; reviews: Set<string> }>();
  for (const event of snapshot.scheduling.flow.events) {
    const key = flowSenseId(event.word);
    const item = facts.get(key) ?? {
      first: event.occurredAt,
      completed: false,
      reviews: new Set<string>(),
    };
    item.first = Math.min(item.first, event.occurredAt);
    if (event.kind === 'completion') item.completed = true;
    if (event.kind === 'review') item.reviews.add(event.sourceId);
    facts.set(key, item);
  }
  const completedLegacy = new Set<string>();
  const currentLearning = new Set(
    snapshot.ledger.days.flatMap((day) => (day.flow ? day.learningWords.map(flowSenseId) : [])),
  );
  const legacyReviews = new Map<string, Set<string>>();
  function addReviews(words: MiniWord[], id: string) {
    for (const word of words) {
      const key = flowSenseId(word),
        values = legacyReviews.get(key) ?? new Set<string>();
      values.add(id);
      legacyReviews.set(key, values);
    }
  }
  for (const day of snapshot.ledger.days) {
    if (!day.flow && day.finishedAt !== undefined)
      for (const word of day.learningWords) completedLegacy.add(flowSenseId(word));
    if (day.reviewFinishedAt !== undefined) addReviews(day.reviewWords, day.id);
  }
  for (const record of [snapshot.reviewRecord, ...snapshot.reviewHistory])
    if (record?.session.phase === 'finished') addReviews(record.session.words, record.id);
  let completedWordCount = 0,
    excludedLegacyCount = 0;
  const words: MiniMemoryWord[] = [];
  for (const card of snapshot.scheduling.flow.cards) {
    const fact = facts.get(card.senseId);
    const completed = fact?.completed === true || completedLegacy.has(card.senseId);
    if (completed) completedWordCount++;
    const learning = !completed && (fact?.reviews.size ?? 0) === 0;
    const meaning = projectedAbility(card.meaning, asOf);
    const spelling = projectedAbility(card.spelling, asOf);
    const old = legacy.get(card.senseId);
    const firstSeenAt = Math.min(fact?.first ?? Infinity, old?.introducedAt ?? Infinity);
    words.push({
      senseId: card.senseId,
      word: card.word,
      source: 'flow',
      status: learning ? 'learning' : card.dueAt <= asOf ? 'due' : 'scheduled',
      dueAt: learning ? null : card.dueAt,
      idealDueAt: learning ? null : card.idealDueAt,
      firstSeenAt: Number.isFinite(firstSeenAt) ? firstSeenAt : null,
      lastReviewAt: maximum([meaning?.lastReviewAt, spelling?.lastReviewAt]),
      reviewCount: fact?.reviews.size ?? 0,
      meaning,
      spelling,
    });
    legacy.delete(card.senseId);
  }
  for (const [senseId, card] of legacy) {
    const spelling = projectedAbility(card.fsrs, asOf, snapshot.scheduling.parameters.weights);
    if (completedLegacy.has(senseId)) completedWordCount++;
    if (!spelling) {
      if (currentLearning.has(senseId))
        words.push({
          senseId,
          word: card.word,
          source: 'flow',
          status: 'learning',
          dueAt: null,
          idealDueAt: null,
          firstSeenAt: card.introducedAt,
          lastReviewAt: null,
          reviewCount: 0,
          meaning: null,
          spelling: null,
        });
      else excludedLegacyCount++;
      continue;
    }
    const dueAt = Math.min(card.dueAt, card.nextProbeAt ?? Infinity);
    words.push({
      senseId,
      word: card.word,
      source: 'legacy',
      status: dueAt <= asOf ? 'due' : 'scheduled',
      dueAt,
      idealDueAt: card.fsrs?.due ?? null,
      firstSeenAt: card.introducedAt,
      lastReviewAt: spelling.lastReviewAt,
      reviewCount: legacyReviews.get(senseId)?.size ?? 0,
      meaning: null,
      spelling,
    });
  }
  words.sort(
    (a, b) =>
      (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) ||
      a.word.spelling.localeCompare(b.word.spelling) ||
      a.senseId.localeCompare(b.senseId),
  );
  return { words, completedWordCount, excludedLegacyCount };
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
  const { words, completedWordCount, excludedLegacyCount } = indexedWords(snapshot, asOf);
  const dates = calendar(input.timezone);
  const loads = new Map<string, number>();
  for (const word of words)
    if (word.dueAt !== null && word.dueAt >= input.from && word.dueAt <= input.to) {
      const day = dates.day(word.dueAt);
      loads.set(day, (loads.get(day) ?? 0) + 1);
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
  const indexed = indexedWords(snapshot, asOf);
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
