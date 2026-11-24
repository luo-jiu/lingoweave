import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { miniSnapshotSchema, type MiniExposure } from '@lingoweave/contracts';
import { markLegacyMiniReviewPrompts } from './mini-review-prompt-migration.js';
import { makeReview } from './mini-study.js';

const word = { spelling: 'blue', meaning: '蓝色', phonetic: '' };
const dayId = '2026-11-20';

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE mini_events(seq INTEGER PRIMARY KEY, body TEXT NOT NULL, recorded_at REAL NOT NULL)',
  );
  t.after(() => db.close());
  const session = makeReview([word]);
  session.judgmentEvents.push({
    word,
    selected: 'clear',
    selectedAt: 50,
    final: 'clear',
    finalizedAt: 55,
  });
  const state = miniSnapshotSchema.parse({
    schemaVersion: 1,
    revision: 0,
    imported: true,
    ledger: {
      days: [
        {
          id: dayId,
          startedAt: 1,
          phase: 'review',
          paused: false,
          review: session,
          reviewWords: [word],
          learningWords: [],
          reviewSteps: [0],
          directions: [],
          studiedWords: [],
          sentences: [],
          translation: [],
          translationDraft: '',
          translationIndex: 0,
          scheduleUpdates: [],
        },
      ],
    },
    reviewRecord: null,
    reviewHistory: [],
  });
  const exposure = (at: number, overrides: Partial<MiniExposure> = {}) => {
    const item: MiniExposure = {
      id: randomUUID(),
      target: 'daily',
      dayId,
      session: 'review',
      word,
      source: 'ui',
      kind: 'potentialHelp',
      beforeAttemptCount: 0,
      at,
      focusIds: [],
      ...overrides,
    };
    state.teaching.exposures.push(item);
    return item;
  };
  const log = (occurredAt: number, recordedAt: number, overrides: Record<string, unknown> = {}) => {
    const action = {
      type: 'record_card_view',
      target: 'daily',
      session: 'review',
      dayId,
      word,
      ...overrides,
    };
    db.prepare('INSERT INTO mini_events(body, recorded_at) VALUES (?, ?)').run(
      JSON.stringify({ action, occurredAt, actor: 'user' }),
      recordedAt,
    );
  };
  return { state, exposure, log, migrate: () => markLegacyMiniReviewPrompts(db, state) };
}

test('historical prompts match either actual producer clock and preserve the original facts', (t) => {
  const f = fixture(t);
  f.log(10, 12);
  const atReceipt = f.exposure(12);
  f.log(19, 20);
  const atClick = f.exposure(19);
  f.log(24, 23);
  const clamped = f.exposure(23);
  const unlogged = f.exposure(15);
  const chat = f.exposure(19, { source: 'chat' });
  const sentence = f.exposure(19, {
    visibleSentence: { english: 'It is blue.', chinese: '它是蓝色的。' },
  });
  const original = structuredClone(f.state.teaching.exposures);
  assert.equal(f.migrate(), 3);
  for (const item of [atReceipt, atClick, clamped]) assert.equal(item.reviewPrompt, true);
  for (const item of [unlogged, chat, sentence]) assert.equal(item.reviewPrompt, undefined);
  const expectedIds = new Set([atReceipt.id, atClick.id, clamped.id]);
  assert.deepEqual(
    f.state.teaching.exposures,
    original.map((item) => (expectedIds.has(item.id) ? { ...item, reviewPrompt: true } : item)),
  );
  assert.equal(f.migrate(), 0);
});

test('unattributable, competing and duplicate timestamp exposures retain their help classification', (t) => {
  const f = fixture(t);
  f.exposure(7);
  assert.equal(f.migrate(), 0);
  f.log(10, 12);
  f.exposure(10);
  f.exposure(12); // Two equally possible matches for one command.
  f.log(15, 15);
  f.exposure(15);
  f.exposure(15); // Two indistinguishable UI exposures.
  f.log(17, 18);
  f.log(18, 19);
  f.exposure(18); // Two overlapping command clocks.
  f.log(22, 22);
  f.log(22, 22, { type: 'record_exposure', source: 'ui', kind: 'potentialHelp' });
  f.exposure(22);
  f.log(28, 28, { visibleSentence: { word, english: 'It is blue.', chinese: '它是蓝色的。' } });
  f.exposure(28);
  assert.equal(f.migrate(), 0);
});

test('a cleared choice, an earlier journaled choice, and opening a draft all establish a reveal', (t) => {
  const f = fixture(t);
  const review = f.state.ledger.days[0]?.review;
  assert.ok(review);
  review.clearedJudgments = [{ word, selected: 'fuzzy', selectedAt: 30, clearedAt: 31 }];
  const before = f.exposure(26);
  f.log(26, 26);
  f.log(30, 30);
  const simultaneous = f.exposure(30);
  f.log(32, 32);
  const afterClear = f.exposure(32);
  f.log(40, 40, { type: 'choose_judgment' });
  f.log(20, 42);
  const late = f.exposure(20);
  assert.equal(f.migrate(), 1);
  assert.equal(before.reviewPrompt, true);
  for (const item of [simultaneous, afterClear, late]) assert.equal(item.reviewPrompt, undefined);
  const draft = fixture(t);
  draft.state.practice.dictations.push({
    id: randomUUID(),
    dayId,
    target: 'daily',
    session: 'review',
    word,
    openedAt: 15,
    attempts: [],
  });
  draft.log(16, 16);
  draft.exposure(16);
  assert.equal(draft.migrate(), 0);
});
