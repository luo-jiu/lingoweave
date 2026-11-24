import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { forgetting_curve, generatorParameters, fsrs } from 'ts-fsrs';
import {
  miniSnapshotSchema,
  type MiniFlowScheduleEvent,
  type MiniSnapshot,
  type MiniWord,
} from '@lingoweave/contracts';
import {
  flowMemory,
  flowMemoryHistory,
  flowRetrievability,
  flowSenseId,
  rebuildMiniFlowDueSchedules,
  recordFlowSchedule,
  validateMiniFlowScheduling,
} from './mini-flow-scheduler.js';
import { memoryDetail, memoryOverview } from './mini-memory.js';
import { orderMiniDue } from './mini-scheduler.js';
import { swiftTime } from './mini-study.js';

const word: MiniWord = { spelling: 'bag', meaning: '包', phonetic: '' };
const base = swiftTime(new Date('2026-03-07T12:00:00Z'));
const day = 86400;
const params = generatorParameters({
  request_retention: 0.9,
  enable_fuzz: false,
  enable_short_term: true,
  learning_steps: [],
  relearning_steps: [],
});
function snapshot() {
  return miniSnapshotSchema.parse({
    schemaVersion: 1,
    revision: 0,
    imported: true,
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
  });
}
function append(state: MiniSnapshot, overrides: Partial<Omit<MiniFlowScheduleEvent, 'load'>> = {}) {
  const event = {
    id: randomUUID(),
    word,
    kind: 'review' as const,
    sourceId: 'review',
    occurredAt: base,
    recordedAt: base,
    timezone: 'America/New_York',
    meaning: 'Good' as const,
    spelling: null,
    evidence: 'self_report' as const,
    nextDay: false,
    reasons: ['isolated memory visualization audit'],
    ...overrides,
  };
  recordFlowSchedule(state, event);
  return event;
}
const unixDate = (at: number) => new Date((at + 978307200) * 1000);

test('due words are ordered by their current measured abilities before the oldest-waiting slot', () => {
  const state = snapshot();
  const weak = { ...word, spelling: 'zebra' };
  append(state);
  append(state, { word: weak, meaning: 'Again', spelling: null });
  const items = [
    { word, schedule: { dueAt: base } },
    { word: weak, schedule: { dueAt: base + day } },
  ];
  assert.equal(orderMiniDue(items, state.scheduling, base + 5 * day)[0], items[1]);
  state.scheduling.servedCount = 4;
  assert.equal(orderMiniDue(items, state.scheduling, base + 5 * day)[0], items[0]);
});

test('corrected headword formatting retains the sense history and can repair an audited older schedule', () => {
  const state = snapshot();
  const revised = { ...word, spelling: word.spelling.toUpperCase(), phonetic: '/new/' };
  append(state);
  const second = append(state, { word: revised, sourceId: 'review-2', occurredAt: base + 4 * day });
  assert.equal(flowMemory(state, revised)?.meaning?.reps, 2);
  assert.equal(flowMemoryHistory(state, word).length, 2);
  assert.deepEqual(state.scheduling.flow.events.at(-1)?.load, {});
  const correct = structuredClone(state.scheduling.flow.cards);

  const old = snapshot();
  append(old, second);
  state.scheduling.flow.cards = structuredClone(old.scheduling.flow.cards);
  const last = state.scheduling.flow.changes.at(-1);
  const former = state.scheduling.flow.cards[0];
  assert.ok(last && former);
  last.after = structuredClone(former);
  assert.throws(() => validateMiniFlowScheduling(state));
  validateMiniFlowScheduling(state, undefined, { allowArchivedDueDates: true });
  assert.equal(rebuildMiniFlowDueSchedules(state, base + 5 * day), true);
  assert.deepEqual(state.scheduling.flow.cards, correct);
  assert.equal(rebuildMiniFlowDueSchedules(state, base + 5 * day), false);
  validateMiniFlowScheduling(state);

  const differentSense = { ...revised, meaning: '另一个义项' };
  append(state, { word: differentSense, sourceId: 'other-sense' });
  assert.equal(flowMemory(state, differentSense)?.meaning?.reps, 1);
  assert.equal(flowMemory(state, word)?.meaning?.reps, 2);
});

test('memory display uses actual FSRS-6 decay and fractional days, preserving unknown ability states', () => {
  const state = snapshot();
  append(state);
  const card = flowMemory(state, word)?.meaning;
  assert.ok(card && card.last_review !== undefined);
  const before = structuredClone(state);
  const halfDay = card.last_review + day / 2;
  assert.equal(flowRetrievability(card, halfDay), forgetting_curve(params.w, 0.5, card.stability));
  assert.ok((flowRetrievability(card, halfDay) ?? 1) < 1);
  const discrete = fsrs(params).get_retrievability(
    { ...card, due: unixDate(card.due), last_review: unixDate(card.last_review) },
    unixDate(halfDay),
    false,
  );
  assert.equal(
    discrete,
    1,
    'the library convenience method floors whole days and is not a smooth display curve',
  );
  assert.ok(
    Math.abs((flowRetrievability(card, card.last_review + card.stability * day) ?? 0) - 0.9) <
      0.000001,
  );
  const historicalWeights = [...params.w];
  historicalWeights[20] = 0.8;
  assert.equal(
    flowRetrievability(card, halfDay, historicalWeights),
    forgetting_curve(historicalWeights, 0.5, card.stability),
  );
  assert.notEqual(
    flowRetrievability(card, halfDay, historicalWeights),
    flowRetrievability(card, halfDay),
  );
  for (const invalid of [
    null,
    undefined,
    { ...card, stability: 0 },
    { ...card, last_review: undefined },
    { ...card, state: 0 },
  ])
    assert.equal(flowRetrievability(invalid, halfDay), null);
  assert.equal(
    flowRetrievability(card, card.last_review - 1),
    null,
    'a later state cannot be back-projected as historical 100%',
  );
  assert.equal(flowRetrievability(card, NaN), null);
  assert.equal(flowRetrievability(card, halfDay, []), null);
  assert.deepEqual(state, before);
});

test('late assessment history is reconstructed in occurrence order instead of using changes.after as a past state', () => {
  const state = snapshot();
  const completion = append(state, {
    kind: 'completion',
    sourceId: 'completed',
    meaning: null,
    evidence: 'learning',
    nextDay: true,
  });
  const review = append(state, {
    occurredAt: base + day,
    recordedAt: base + day,
    sourceId: 'review-1',
  });
  const late = append(state, {
    kind: 'assessment',
    sourceId: 'assessment',
    occurredAt: base + 600,
    recordedAt: base + 2 * day,
    evidence: 'model',
    meaning: 'Again',
  });
  const before = structuredClone(state);
  const history = flowMemoryHistory(state, word);
  assert.deepEqual(
    history.map((item) => item.event.id),
    [completion.id, late.id, review.id],
  );
  assert.equal(history[0]?.meaning, null);
  assert.equal(history[1]?.meaning?.last_review, late.occurredAt);
  assert.equal(
    state.scheduling.flow.changes.at(-1)?.after.meaning?.last_review,
    review.occurredAt,
    'late-change audit snapshots describe the recomputed latest state',
  );
  assert.equal(history[2]?.meaning?.last_review, review.occurredAt);
  assert.deepEqual(history.at(-1)?.meaning, flowMemory(state, word)?.meaning);
  assert.deepEqual(history.at(-1)?.spelling, flowMemory(state, word)?.spelling);
  assert.deepEqual(state, before);
});

test('support and completion markers do not reset or invent measured memory between actual ability updates', () => {
  const state = snapshot();
  append(state, { kind: 'completion', meaning: null, evidence: 'learning', nextDay: true });
  append(state, { occurredAt: base + day, recordedAt: base + day });
  const support = append(state, {
    kind: 'assessment',
    sourceId: 'supported',
    occurredAt: base + day + 600,
    recordedAt: base + day + 900,
    meaning: null,
    spelling: null,
    evidence: 'model',
  });
  append(state, {
    kind: 'probe',
    sourceId: 'spelling-probe',
    occurredAt: base + 2 * day,
    recordedAt: base + 2 * day,
    meaning: null,
    spelling: 'Good',
    evidence: 'objective',
  });
  const history = flowMemoryHistory(state, word);
  assert.equal(history[0]?.meaning, null);
  assert.equal(history[0]?.spelling, null);
  assert.deepEqual(history[2]?.meaning, history[1]?.meaning);
  assert.equal(history[2]?.spelling, null);
  assert.ok((flowRetrievability(history[2]?.meaning, support.occurredAt) ?? 1) < 1);
  assert.deepEqual(history[3]?.meaning, history[1]?.meaning);
  assert.ok(history[3]?.spelling);
  assert.equal(history[3]?.event.evidence, 'objective');
});

test('overview and selected-word curves remain read-only with 3000 tracked words', (context) => {
  const state = snapshot();
  append(state);
  const templateCard = state.scheduling.flow.cards[0];
  const templateEvent = state.scheduling.flow.events[0];
  assert.ok(templateCard && templateEvent);
  state.scheduling.flow.cards = [];
  state.scheduling.flow.events = [];
  state.scheduling.flow.changes = [];
  for (let index = 0; index < 3000; index++) {
    const item: MiniWord = { spelling: `word-${index}`, meaning: `义项-${index}`, phonetic: '' };
    state.scheduling.flow.cards.push({
      ...structuredClone(templateCard),
      word: item,
      senseId: flowSenseId(item),
    });
    state.scheduling.flow.events.push({
      ...structuredClone(templateEvent),
      id: randomUUID(),
      sourceId: `isolated-review-${index}`,
      word: item,
    });
  }
  const before = structuredClone(state);
  const input = { timezone: 'Asia/Shanghai', from: base - 30 * day, to: base + 365 * day };
  const started = performance.now();
  const overview = memoryOverview(state, input, base + day / 2);
  const elapsed = performance.now() - started;
  context.diagnostic(`3000-word/3000-event read-only overview: ${elapsed.toFixed(2)} ms`);
  assert.equal(overview.summary.wordCount, 3000);
  assert.equal(overview.summary.measuredWordCount, 3000);
  assert.ok(elapsed < 2000, 'overview must index once instead of replaying every word history');
  const selected = overview.words[1500];
  assert.ok(selected);
  const detail = memoryDetail(state, { ...input, senseId: selected.senseId }, base + day / 2);
  assert.equal(detail.events.length, 1);
  assert.equal(
    detail.events[0]?.id,
    state.scheduling.flow.events.find((event) => flowSenseId(event.word) === selected.senseId)?.id,
  );
  assert.ok(detail.points.some((point) => point.meaning !== null));
  assert.ok(detail.points.every((point) => point.spelling === null));
  assert.equal(overview.revision, state.revision);
  assert.equal(detail.revision, state.revision);
  assert.deepEqual(state, before, 'read endpoints cannot change facts, scheduling, or revision');
});
