import type { DatabaseSync } from 'node:sqlite';
import {
  miniPatternPracticeSchema,
  miniPatternLevelSchema,
  miniPatternViewSchema,
  type MiniPatternView,
  type MiniPatternLevel,
  type MiniPatternPractice,
  type MiniPatternResult,
  type MiniPatternSnapshot,
} from '@lingoweave/contracts';
import { z } from 'zod';
import { LearningError } from './learning-store.js';
import { localDay } from './mini-study.js';
import {
  normalizedSubstitution,
  patternBatch,
  patternCurriculum,
} from './mini-pattern-curriculum.js';

export function migrateMiniPatterns(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mini_pattern_batches (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, level TEXT NOT NULL, card_ids TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mini_pattern_attempts (
      seq INTEGER PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
      batch_id TEXT NOT NULL REFERENCES mini_pattern_batches(id), pattern_id TEXT NOT NULL,
      input TEXT NOT NULL, at_ms INTEGER NOT NULL, reference TEXT NOT NULL,
      matched INTEGER NOT NULL, completed INTEGER NOT NULL, assisted INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS mini_pattern_completion
      ON mini_pattern_attempts(pattern_id) WHERE completed=1;
    CREATE INDEX IF NOT EXISTS mini_pattern_attempt_batch ON mini_pattern_attempts(batch_id,seq);
  `);
}

export function recordMiniPatternView(
  db: DatabaseSync,
  raw: MiniPatternView,
  now: Date,
  level: MiniPatternLevel,
) {
  const input = miniPatternViewSchema.parse(raw);
  const saved = db
    .prepare('SELECT 1 FROM mini_pattern_views WHERE pattern_id=? AND batch_id=?')
    .get(input.patternId, input.batchId);
  if (!saved) {
    const current = miniPatternSnapshot(db, input.timezone, now, level);
    const card = current.batch.find((item) => !current.completedIds.includes(item.id));
    if (current.batchId !== input.batchId || card?.id !== input.patternId)
      throw new LearningError('MINI_PATTERN_CONFLICT', '只能记录当前显示的句式。');
    db.prepare(
      'INSERT OR IGNORE INTO mini_pattern_views(pattern_id,batch_id,at_ms) VALUES (?,?,?)',
    ).run(input.patternId, input.batchId, now.getTime());
  }
  return { recorded: true };
}
const flag = z.union([z.literal(0), z.literal(1)]);
const completedRow = z.object({ pattern_id: z.string(), assisted: flag });
const attemptRow = z.object({ input: z.string(), matched: flag, reference: z.string() });
const batchRow = z.object({
  id: z.string(),
  level: miniPatternLevelSchema,
  card_ids: z.string(),
  at_ms: z.number(),
});
function exercise(id: string) {
  const record = patternCurriculum.find((entry) => entry.card.id === id);
  if (!record) throw new Error('Stored mini pattern exercise is missing from the catalog.');
  return record;
}
function completedRows(db: DatabaseSync) {
  return db
    .prepare('SELECT pattern_id,assisted FROM mini_pattern_attempts WHERE completed=1 ORDER BY seq')
    .all()
    .map((row) => completedRow.parse(row));
}

export function practicedPatternContext(db: DatabaseSync, level: MiniPatternLevel) {
  return {
    level,
    practiced: completedRows(db).map((row) => {
      const { id, level, frame, meaning, example } = exercise(row.pattern_id).card;
      return { id, level, frame, meaning, example, independent: !row.assisted };
    }),
  };
}

export function miniPatternSnapshot(
  db: DatabaseSync,
  timezone: string,
  now: Date,
  level: MiniPatternLevel,
): MiniPatternSnapshot {
  const date = localDay(now, timezone);
  const rows = completedRows(db);
  const completed = new Set(rows.map((row) => row.pattern_id));
  const raw = db
    .prepare(
      `SELECT b.id,b.level,b.card_ids,a.at_ms FROM mini_pattern_batches b
    JOIN mini_pattern_attempts a ON b.id=a.batch_id ORDER BY a.seq DESC LIMIT 1`,
    )
    .get();
  const summarize = (level: MiniPatternLevel) => {
    const entries = patternCurriculum.filter((entry) => entry.card.level === level);
    return {
      practicedCount: entries.filter((entry) => completed.has(entry.card.id)).length,
      totalCount: entries.length,
      canDialogue: completed.size > 0,
    };
  };
  let limit = 5;
  if (raw) {
    const saved = batchRow.parse(raw);
    const ids = z.array(z.string()).parse(JSON.parse(saved.card_ids));
    const completedIds = ids.filter((id) => completed.has(id));
    // Finishing yesterday's (or last week's) batch spends today's introduction allowance.
    if (completedIds.length !== ids.length || localDay(new Date(saved.at_ms), timezone) === date) {
      return {
        date,
        level: saved.level,
        batchId: saved.id,
        batch: ids.map((id) => exercise(id).card),
        completedIds,
        ...summarize(saved.level),
      };
    }
    const supported = rows.filter((row) => ids.includes(row.pattern_id) && row.assisted).length;
    if (saved.level === level && supported >= 2 && supported * 2 >= ids.length) limit = 2;
  }
  const batch = patternBatch(level, completed, limit);
  return {
    date,
    level,
    batchId: `v1/${date}/${level}/${batch.map((c) => c.id).join('+')}`,
    batch,
    completedIds: [],
    ...summarize(level),
  };
}

// Called within the study store's BEGIN IMMEDIATE transaction. Pattern activity is not
// a word command: it has its own receipts and cannot advance the user's word revision.
export function practiceMiniPattern(
  db: DatabaseSync,
  raw: MiniPatternPractice,
  now: Date,
  level: MiniPatternLevel,
): MiniPatternResult {
  const input = miniPatternPracticeSchema.parse(raw);
  const snapshot = () => miniPatternSnapshot(db, input.timezone, now, level);
  const previous = db
    .prepare('SELECT input,matched,reference FROM mini_pattern_attempts WHERE request_id=?')
    .get(input.requestId);
  const body = JSON.stringify(input);
  if (previous) {
    const saved = attemptRow.parse(previous);
    if (saved.input !== body)
      throw new LearningError('REQUEST_CONFLICT', '相同请求身份不能用于不同句式作答。');
    return { correct: Boolean(saved.matched), reference: saved.reference, snapshot: snapshot() };
  }
  const current = snapshot();
  const card = current.batch.find((card) => !current.completedIds.includes(card.id));
  if (!card || input.batchId !== current.batchId || input.patternId !== card.id)
    throw new LearningError('MINI_PATTERN_CONFLICT', '句式进度已变化，请重新读取当前练习。');
  const { references } = exercise(card.id);
  const reference = references[0];
  if (!reference) throw new Error('A pattern exercise requires a reference substitution.');
  const correct = references.some(
    (value) => normalizedSubstitution(value) === normalizedSubstitution(input.answer),
  );
  const prior = db
    .prepare(
      'SELECT input FROM mini_pattern_attempts WHERE batch_id=? AND pattern_id=? ORDER BY seq DESC LIMIT 1',
    )
    .get(current.batchId, card.id);
  if (input.continueAfterFeedback) {
    if (
      !prior ||
      !input.usedHint ||
      miniPatternPracticeSchema.parse(JSON.parse(z.string().parse(prior.input))).answer !==
        input.answer
    )
      throw new LearningError('MINI_PATTERN_FEEDBACK_REQUIRED', '请先尝试换写，再继续。');
  }
  db.prepare('INSERT OR IGNORE INTO mini_pattern_batches (id,level,card_ids) VALUES (?,?,?)').run(
    current.batchId,
    current.level,
    JSON.stringify(current.batch.map((card) => card.id)),
  );
  db.prepare(
    `INSERT INTO mini_pattern_attempts
    (request_id,batch_id,pattern_id,input,at_ms,reference,matched,completed,assisted) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    input.requestId,
    current.batchId,
    card.id,
    body,
    now.getTime(),
    reference,
    Number(correct),
    Number(correct || Boolean(input.continueAfterFeedback)),
    Number(input.usedHint || Boolean(prior)),
  );
  return { correct, reference, snapshot: snapshot() };
}
