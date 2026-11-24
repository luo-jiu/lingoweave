import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  miniSnapshotSchema,
  miniMemoryOverviewSchema,
  type MiniFlowScheduleEvent,
  type MiniSnapshot,
  type MiniDay,
} from '@lingoweave/contracts';
import { buildApp } from './app.js';
import { MiniStore } from './mini-store.js';
import { flowSenseId, recordFlowSchedule } from './mini-flow-scheduler.js';
import { memoryOverview, memoryDetail } from './mini-memory.js';
import { makeReview, swiftTime } from './mini-study.js';
import { initializeMiniScheduling } from './mini-scheduler.js';
import { miniPlanContext } from './mini-planning.js';
import { miniWordProgress } from './mini-vocabulary-store.js';

const timezone = 'Asia/Shanghai';
const at = swiftTime(new Date('2026-11-17T01:00:00Z'));
const word = { spelling: 'bag', meaning: '包', phonetic: '' };
const input = { timezone, from: at - 86400, to: at + 90 * 86400 };
function state() {
  return miniSnapshotSchema.parse({
    schemaVersion: 1,
    revision: 0,
    imported: true,
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
  });
}
function add(snapshot: MiniSnapshot, changes: Partial<Omit<MiniFlowScheduleEvent, 'load'>> = {}) {
  recordFlowSchedule(snapshot, {
    id: 'completion',
    sourceId: 'answer',
    word,
    kind: 'completion',
    occurredAt: at,
    recordedAt: at,
    timezone,
    meaning: null,
    spelling: null,
    evidence: 'learning',
    nextDay: true,
    reasons: ['实际事件测试'],
    ...changes,
  });
}
test('the memory view counts an unfinished word as in progress only on its study day', (t) => {
  const store = new MiniStore(':memory:', {
    timezone,
    now: () => new Date('2026-11-17T01:00:00Z'),
  });
  t.after(() => store.close());
  store.importLegacy({
    requestId: randomUUID(),
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
    timezone,
  });
  const snapshot = store.command({
    requestId: randomUUID(),
    expectedRevision: store.snapshot().revision,
    action: {
      type: 'begin',
      target: 'daily',
      timezone,
      deck: [word],
      flowVersion: 'sliding-window-v2',
    },
  });
  assert.equal(memoryOverview(snapshot, input, at).summary.learningCount, 1);
  const following = memoryOverview(snapshot, input, at + 86400);
  assert.equal(following.summary.learningCount, 0);
  assert.equal(following.summary.completedWordCount, 0);
  assert.equal(following.summary.dueCount, 0);
  assert.equal(following.summary.excludedLegacyCount, 0);
});
test('memory empty and unmeasured completion remain honest and read-only', () => {
  const snapshot = state(),
    empty = structuredClone(snapshot);
  assert.equal(memoryOverview(snapshot, input, at).summary.wordCount, 0);
  assert.deepEqual(snapshot, empty);
  add(snapshot);
  const original = structuredClone(snapshot);
  const overview = memoryOverview(snapshot, input, at + 60);
  assert.equal(overview.summary.completedWordCount, 1);
  assert.equal(overview.summary.measuredWordCount, 0);
  assert.equal(overview.words[0]?.meaning, null);
  assert.equal(overview.words[0]?.spelling, null);
  assert.equal(
    overview.load.reduce((sum, item) => sum + item.count, 0),
    1,
  );
  const detail = memoryDetail(snapshot, { ...input, senseId: flowSenseId(word) }, at + 60);
  assert.ok(detail.points.every((point) => point.meaning === null && point.spelling === null));
  assert.equal(detail.events[0]?.kind, 'completion');
  assert.deepEqual(snapshot, original);
});
test('saved dimensions yield separate continuous estimates and future assumes no more reviews', () => {
  const snapshot = state();
  add(snapshot);
  add(snapshot, {
    id: 'review',
    sourceId: 'review-one',
    kind: 'review',
    occurredAt: at + 86400,
    recordedAt: at + 86400,
    meaning: 'Good',
    evidence: 'self_report',
    nextDay: false,
  });
  const detail = memoryDetail(snapshot, { ...input, senseId: flowSenseId(word) }, at + 2 * 86400);
  assert.ok(detail.points.length <= 300);
  assert.equal(detail.word.spelling, null);
  assert.equal(detail.word.reviewCount, 1);
  assert.ok(
    detail.points.filter((point) => point.at < at + 86400).every((point) => point.meaning === null),
  );
  const future = detail.points.filter((point) => point.projected);
  assert.ok(future.length > 1);
  for (let i = 1; i < future.length; i++) {
    const before = future[i - 1]?.meaning,
      after = future[i]?.meaning;
    assert.ok(before !== undefined && before !== null && after !== undefined && after !== null);
    assert.ok(after <= before);
  }
  assert.equal(detail.estimation.label, 'estimated');
});
test('late assessment reconstructs historical ability order without treating change.after as the old state', () => {
  const early = state(),
    late = state();
  const evaluation: Partial<Omit<MiniFlowScheduleEvent, 'load'>> = {
    id: 'assessment',
    kind: 'assessment',
    meaning: 'Again',
    evidence: 'model',
    occurredAt: at + 1,
    recordedAt: at + 1,
    nextDay: false,
  };
  const review: Partial<Omit<MiniFlowScheduleEvent, 'load'>> = {
    id: 'review',
    sourceId: 'review',
    kind: 'review',
    meaning: 'Good',
    evidence: 'self_report',
    occurredAt: at + 86400,
    recordedAt: at + 86400,
    nextDay: false,
  };
  add(early);
  add(early, evaluation);
  add(early, review);
  add(late);
  add(late, review);
  add(late, { ...evaluation, recordedAt: at + 2 * 86400 });
  const range = { ...input, senseId: flowSenseId(word) };
  const a = memoryDetail(early, range, at + 3 * 86400),
    b = memoryDetail(late, range, at + 3 * 86400);
  assert.deepEqual(a.points, b.points);
  assert.deepEqual(a.word, b.word);
  const marker = b.events.find((event) => event.id === 'assessment');
  assert.equal(marker?.occurredAt, at + 1);
  assert.equal(marker?.recordedAt, at + 2 * 86400);
});
test('daily load uses real next due and requested timezone across DST', () => {
  const snapshot = state();
  const first = swiftTime(new Date('2026-03-07T14:00:00Z'));
  add(snapshot, { id: 'one', timezone: 'America/New_York', occurredAt: first, recordedAt: first });
  add(snapshot, {
    id: 'two',
    word: { ...word, spelling: 'book' },
    timezone: 'America/New_York',
    occurredAt: first + 86400,
    recordedAt: first + 86400,
  });
  const result = memoryOverview(
    snapshot,
    { timezone: 'America/New_York', from: first, to: first + 4 * 86400 },
    first + 86400,
  );
  assert.deepEqual(
    result.load.map((item) => [item.day, item.count]),
    [
      ['2026-03-08', 1],
      ['2026-03-09', 1],
    ],
  );
  const [firstDay, secondDay] = result.load;
  assert.ok(firstDay && secondDay);
  assert.equal(secondDay.at - firstDay.at, 23 * 3600);
});
function legacyDay(id: string, overrides: Partial<MiniDay> = {}): MiniDay {
  return {
    id,
    startedAt: at - 2 * 86400,
    reviewWords: [],
    learningWords: [],
    reviewSteps: [],
    directions: [],
    paused: false,
    phase: 'finished',
    studiedWords: [],
    sentences: [],
    translation: [],
    translationDraft: '',
    translationIndex: 0,
    scheduleUpdates: [],
    ...overrides,
  };
}

test('home and curve count identical daily work across backlog, unavailable abilities and an in-flight group', () => {
  const snapshot = state(),
    legacy = { ...word, spelling: 'book' },
    today = { ...word, spelling: 'tree' };
  add(snapshot, { id: 'first', occurredAt: at - 3 * 86400 });
  add(snapshot, { id: 'future', word: today }); // First review scheduled tomorrow.
  snapshot.ledger.days.push(
    legacyDay('2026-11-14', {
      learningWords: [word, legacy, today],
      finishedAt: at - 86400,
      scheduleUpdates: [word, legacy, today].map((target) => ({
        word: target,
        dueAt: at - 86400,
        recordedAt: at - 2 * 86400,
        step: 0,
        source: 'learning',
        policyVersion: 1 as const,
      })),
    }),
    legacyDay('2026-11-17', {
      startedAt: at,
      phase: 'review',
      reviewWords: [today],
      review: makeReview([today]),
    }),
  );
  const before = structuredClone(snapshot);
  const narrow = { timezone, from: at + 86400 + 3600, to: at + 86400 + 7200 };
  const plan = miniPlanContext(snapshot, { timezone, deck: [] }, at);
  const overview = memoryOverview(snapshot, narrow, at);
  assert.equal(plan.dueCount, 3);
  assert.equal(overview.summary.dueCount, plan.dueCount);
  assert.equal(overview.summary.overdueCount, 2);
  assert.equal(overview.summary.completedWordCount, miniWordProgress(snapshot.ledger, []).lifetime);
  assert.equal(overview.summary.measuredWordCount, 0);
  const pending = overview.words.find((row) => row.word.spelling === today.spelling);
  assert.equal(pending?.inCurrentReview, true);
  assert.ok(pending?.dueAt && pending.dueAt > at);
  assert.equal(
    overview.words.find((row) => row.word.spelling === legacy.spelling)?.dueAt,
    at - 86400,
  );
  assert.deepEqual(
    overview.load.map((row) => [row.day, row.count]),
    [['2026-11-18', 1]],
  );
  assert.deepEqual(snapshot, before);
});

test('an unfinished word can have independent spelling evidence without joining the daily review queue', () => {
  const snapshot = state(),
    evidence = state();
  add(evidence, {
    kind: 'probe',
    spelling: 'Good',
    meaning: null,
    evidence: 'objective',
    nextDay: false,
  });
  initializeMiniScheduling(snapshot);
  const fsrs = evidence.scheduling.flow.cards[0]?.spelling;
  assert.ok(fsrs);
  snapshot.scheduling.cards.push({
    senseId: flowSenseId(word),
    word,
    ability: 'spelling',
    introducedAt: at - 86400,
    dueAt: at - 1,
    lastServedAt: null,
    exposureKnown: true,
    lastAnswerExposureAt: null,
    state: 'review',
    fsrs,
  });
  snapshot.ledger.days.push(legacyDay('2026-11-15', { phase: 'learning', learningWords: [word] }));
  const plan = miniPlanContext(snapshot, { timezone, deck: [word] }, at);
  const overview = memoryOverview(snapshot, input, at);
  assert.equal(plan.dueCount, 0);
  assert.equal(overview.summary.dueCount, plan.dueCount);
  assert.equal(overview.summary.completedWordCount, 0);
  assert.equal(overview.summary.measuredWordCount, 1);
  assert.equal(overview.words[0]?.dueAt, null);
  assert.equal(overview.words[0]?.status, 'unmeasured');
  assert.deepEqual(overview.load, []);
  assert.equal(
    memoryDetail(snapshot, { ...input, senseId: flowSenseId(word) }, at).points.some(
      (p) => p.spelling !== null,
    ),
    true,
  );
});

test('translation ratings and support-only reviews do not fabricate a past review date or duplicate a group', () => {
  const snapshot = state();
  add(snapshot);
  add(snapshot, {
    id: 'assessment',
    kind: 'assessment',
    meaning: 'Good',
    evidence: 'model',
    occurredAt: at + 1,
    nextDay: false,
  });
  const assessed = memoryOverview(snapshot, input, at + 60).words[0];
  assert.ok(assessed?.meaning);
  assert.equal(assessed.reviewCount, 0);
  assert.equal(assessed.lastReviewAt, null);
  for (const [i, id] of ['judgment', 'spelling'].entries())
    add(snapshot, {
      id,
      kind: 'review',
      sourceId: 'group',
      evidence: 'learning',
      occurredAt: at + 86400 + i,
      nextDay: true,
    });
  const reviewed = memoryOverview(snapshot, input, at + 2 * 86400).words[0];
  assert.equal(reviewed?.reviewCount, 1);
  assert.equal(reviewed.lastReviewAt, at + 86401);
});

test('memory HTTP inherits bearer and origin protection, validates range, and never saves reads', async (t) => {
  const store = new MiniStore(':memory:');
  const token = 'a'.repeat(64),
    app = buildApp({ mini: { store, token } });
  t.after(() => app.close());
  const before = store.snapshot();
  for (const endpoint of ['overview', 'detail']) {
    const url = `/api/mini/memory/${endpoint}`;
    assert.equal((await app.inject({ method: 'POST', url, payload: input })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: input,
          headers: { authorization: `Bearer ${token}`, origin: 'http://localhost' },
        })
      ).statusCode,
      403,
    );
  }
  const headers = { authorization: `Bearer ${token}` };
  for (const payload of [
    { ...input, timezone: 'invalid/timezone' },
    { ...input, to: input.from },
    { ...input, to: input.from + 733 * 86400 },
    { ...input, from: -1e20 },
  ]) {
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/mini/memory/overview', headers, payload }))
        .statusCode,
      400,
    );
  }
  const response = await app.inject({
    method: 'POST',
    url: '/api/mini/memory/overview',
    headers,
    payload: input,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(miniMemoryOverviewSchema.parse(response.json()).summary.wordCount, 0);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/mini/memory/detail',
        headers,
        payload: { ...input, senseId: 'missing' },
      })
    ).statusCode,
    404,
  );
  assert.deepEqual(store.snapshot(), before);
});
