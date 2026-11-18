import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { miniSnapshotSchema, type MiniSnapshot, type MiniWord } from '@lingoweave/contracts';
import { LearningError } from './learning-store.js';
import { MiniStore } from './mini-store.js';
import { recordFlowSchedule, validateMiniFlowScheduling } from './mini-flow-scheduler.js';
import { swiftTime } from './mini-study.js';

const at = swiftTime(new Date('2026-11-17T03:00:00Z'));
const words: MiniWord[] = [
  { spelling: 'apple', meaning: '苹果', phonetic: '' },
  { spelling: 'bag', meaning: '包', phonetic: '' },
  { spelling: 'book', meaning: '书', phonetic: '' },
];
function empty() {
  return miniSnapshotSchema.parse({
    schemaVersion: 1,
    revision: 0,
    imported: true,
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
  });
}
function add(
  state: MiniSnapshot,
  word: MiniWord,
  day: number,
  kind: 'completion' | 'review' = 'review',
) {
  recordFlowSchedule(state, {
    id: randomUUID(),
    word,
    kind,
    sourceId: `review-${day}`,
    occurredAt: at + day * 86400,
    recordedAt: at + (day + 1) * 86400,
    timezone: 'Asia/Shanghai',
    meaning: kind === 'review' ? 'Good' : null,
    spelling: null,
    evidence: kind === 'review' ? 'self_report' : 'learning',
    nextDay: kind === 'completion',
    reasons: ['isolated validation fixture'],
  });
}
const conflict = (error: unknown) =>
  error instanceof LearningError && error.code === 'MINI_SCHEDULE_CONFLICT';

test('incremental validation agrees with full validation after append and late replay without changing any fact', () => {
  const state = empty();
  for (const word of words) add(state, word, 0, 'completion');
  validateMiniFlowScheduling(state);
  for (const day of [1, 5, 12, 3]) {
    for (const word of words) {
      add(state, word, day);
      const before = structuredClone(state);
      validateMiniFlowScheduling(state, [word, { ...word }]);
      validateMiniFlowScheduling(state, []);
      validateMiniFlowScheduling(state);
      assert.deepEqual(
        state,
        before,
        'validation must not change ratings, due dates, audit, or source events',
      );
    }
  }
});

test('incremental replay rejects corruption of every affected word', () => {
  for (const word of words) {
    const state = empty();
    for (const target of words) add(state, target, 0, 'completion');
    const changed = state.scheduling.flow.cards.find(
      (card) => card.word.spelling === word.spelling,
    );
    assert.ok(changed);
    changed.dueAt += 60;
    assert.throws(() => validateMiniFlowScheduling(state, [word]), conflict);
    assert.throws(() => validateMiniFlowScheduling(state), conflict);
  }
});

test('empty affected set still checks global identities and event/card/change associations', () => {
  const original = empty();
  for (const word of words) add(original, word, 0, 'completion');
  const duplicateEvent = structuredClone(original),
    event = duplicateEvent.scheduling.flow.events[0];
  assert.ok(event);
  duplicateEvent.scheduling.flow.events.push(event);
  assert.throws(() => validateMiniFlowScheduling(duplicateEvent, []), conflict);
  const duplicateCard = structuredClone(original),
    card = duplicateCard.scheduling.flow.cards[0];
  assert.ok(card);
  duplicateCard.scheduling.flow.cards.push(card);
  assert.throws(() => validateMiniFlowScheduling(duplicateCard, []), conflict);
  const missingEvent = structuredClone(original),
    change = missingEvent.scheduling.flow.changes[0];
  assert.ok(change);
  change.eventId = 'missing-event';
  assert.throws(() => validateMiniFlowScheduling(missingEvent, []), conflict);
  const wrongIdentity = structuredClone(original),
    wrongCard = wrongIdentity.scheduling.flow.cards[0];
  assert.ok(wrongCard);
  wrongCard.word.spelling = 'another-target';
  assert.throws(() => validateMiniFlowScheduling(wrongIdentity, []), conflict);
});

test('MiniStore reopening still performs full replay and rejects a corrupted saved due date', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-flow-validation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'mini.sqlite');
  const store = new MiniStore(filename);
  const state = store.snapshot();
  store.close();
  for (const word of words) add(state, word, 0, 'completion');
  validateMiniFlowScheduling(state);
  const write = (snapshot: MiniSnapshot) => {
    const db = new DatabaseSync(filename);
    try {
      db.prepare('UPDATE mini_state SET body=? WHERE id=1').run(JSON.stringify(snapshot));
    } finally {
      db.close();
    }
  };
  write(state);
  const valid = new MiniStore(filename);
  assert.deepEqual(valid.snapshot(), state);
  valid.close();
  const card = state.scheduling.flow.cards.at(-1);
  assert.ok(card);
  card.dueAt += 60;
  write(state);
  assert.throws(() => new MiniStore(filename), conflict);
});
