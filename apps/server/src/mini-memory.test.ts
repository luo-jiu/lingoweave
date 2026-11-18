import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  miniSnapshotSchema,
  miniMemoryOverviewSchema,
  type MiniFlowScheduleEvent,
  type MiniSnapshot,
} from '@lingoweave/contracts';
import { buildApp } from './app.js';
import { MiniStore } from './mini-store.js';
import { flowSenseId, recordFlowSchedule } from './mini-flow-scheduler.js';
import { memoryOverview, memoryDetail } from './mini-memory.js';
import { swiftTime } from './mini-study.js';

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
