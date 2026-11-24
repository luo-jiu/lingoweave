import type { DatabaseSync } from 'node:sqlite';
import {
  miniWordSchema,
  type MiniExposure,
  type MiniSnapshot,
  type MiniWord,
} from '@lingoweave/contracts';
import { z } from 'zod';

const command = z.object({
  occurredAt: z.number().optional(),
  action: z.object({
    type: z.enum(['record_card_view', 'record_exposure', 'choose_judgment']),
    dayId: z.string(),
    word: miniWordSchema,
    session: z.string().optional(),
    visibleSentence: z.unknown().optional(),
    source: z.string().optional(),
    kind: z.string().optional(),
  }),
});

function reviewKey(dayId: string, word: MiniWord) {
  return JSON.stringify([dayId, word.spelling, word.meaning, word.phonetic]);
}

/** Older card views have no command ID on their exposure. Only unambiguous matches are safe to relabel. */
export function markLegacyMiniReviewPrompts(db: DatabaseSync, state: MiniSnapshot): number {
  const candidates = new Map<string, MiniExposure[]>();
  for (const item of state.teaching.exposures) {
    if (
      item.target !== 'daily' ||
      !item.dayId ||
      item.session !== 'review' ||
      item.source !== 'ui' ||
      item.kind !== 'potentialHelp' ||
      item.visibleSentence ||
      item.beforeAttemptCount !== 0 ||
      item.focusIds.length ||
      item.sourceMessageId ||
      item.taskId
    )
      continue;
    const key = JSON.stringify([reviewKey(item.dayId, item.word), item.at]);
    const bucket = candidates.get(key) ?? [];
    bucket.push(item);
    candidates.set(key, bucket);
  }
  if (
    !candidates.size ||
    !db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mini_events'").get()
  )
    return 0;

  const firstReveal = new Map<string, number>();
  for (const day of state.ledger.days) {
    if (!day.review) continue;
    for (const word of day.reviewWords) {
      if (day.review.phase === 'judgment') firstReveal.set(reviewKey(day.id, word), Infinity);
    }
    for (const event of [...day.review.judgmentEvents, ...(day.review.clearedJudgments ?? [])]) {
      const key = reviewKey(day.id, event.word);
      firstReveal.set(key, Math.min(firstReveal.get(key) ?? Infinity, event.selectedAt));
    }
  }
  for (const draft of state.practice.dictations) {
    if (draft.target === 'daily' && draft.session === 'review' && draft.dayId) {
      const key = reviewKey(draft.dayId, draft.word);
      if (firstReveal.has(key))
        firstReveal.set(key, Math.min(firstReveal.get(key) ?? Infinity, draft.openedAt));
    }
  }

  const matched = new Set<MiniExposure>();
  const ambiguous = new Set<MiniExposure>();
  const revealedInJournal = new Set<string>();
  for (const row of db
    .prepare(
      `
    SELECT body, recorded_at FROM mini_events
    WHERE json_extract(body, '$.action.type') IN ('record_card_view', 'choose_judgment', 'record_exposure')
      AND json_extract(body, '$.action.target') = 'daily'
    ORDER BY seq
  `,
    )
    .iterate()) {
    if (typeof row.body !== 'string' || typeof row.recorded_at !== 'number') continue;
    const parsed = command.safeParse(JSON.parse(row.body));
    if (!parsed.success) continue;
    const { action, occurredAt } = parsed.data;
    const key = reviewKey(action.dayId, action.word);
    if (action.session === 'learning' || !firstReveal.has(key)) continue;
    if (action.type === 'choose_judgment') {
      revealedInJournal.add(key);
      continue;
    }
    // Both timestamps existed in the journal. The old producer used reception;
    // a subsequent release stored the earlier of the click and receipt times.
    const seenAt = Math.min(occurredAt ?? row.recorded_at, row.recorded_at);
    const times = new Set([row.recorded_at, seenAt]);
    const exposures = [...times].flatMap((at) => candidates.get(JSON.stringify([key, at])) ?? []);
    if (!exposures.length) continue;
    if (action.type === 'record_exposure') {
      if (action.source === 'ui' && action.kind === 'potentialHelp')
        for (const item of exposures) ambiguous.add(item);
      continue;
    }
    const cutoff = firstReveal.get(key) ?? -Infinity;
    for (const item of exposures) {
      if (
        exposures.length !== 1 ||
        matched.has(item) ||
        action.session !== 'review' ||
        action.visibleSentence !== undefined ||
        revealedInJournal.has(key) ||
        item.at >= cutoff ||
        seenAt >= cutoff
      )
        ambiguous.add(item);
      matched.add(item);
    }
  }
  let count = 0;
  for (const item of matched) {
    if (ambiguous.has(item) || item.reviewPrompt) continue;
    item.reviewPrompt = true;
    count++;
  }
  return count;
}
