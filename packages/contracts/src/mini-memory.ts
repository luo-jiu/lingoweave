import { z } from 'zod';
import { miniWordSchema } from './mini.js';

const at = z.number().finite().min(-978307200).max(252424993199);
const count = z.number().int().nonnegative();
const probability = z.number().min(0).max(1);
const timezone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Expected an IANA timezone');
const range = z.object({ timezone, from: at, to: at }).strict();
const validRange = (value: { from: number; to: number }) =>
  value.from < value.to && value.to - value.from <= 732 * 86400;
export const miniMemoryOverviewInputSchema = range.refine(
  validRange,
  'The range must be increasing and no longer than 732 days',
);
export const miniMemoryDetailInputSchema = range
  .extend({ senseId: z.string().min(1).max(160) })
  .refine(validRange, 'The range must be increasing and no longer than 732 days');
const ability = z
  .object({
    retrievability: probability,
    stability: z.number().positive(),
    difficulty: z.number().nonnegative(),
    lastReviewAt: at,
    reps: count,
    lapses: count,
  })
  .strict();
export const miniMemoryWordSchema = z
  .object({
    senseId: z.string(),
    word: miniWordSchema,
    source: z.enum(['flow', 'legacy']),
    status: z.enum(['learning', 'due', 'scheduled', 'unmeasured']),
    inCurrentReview: z.literal(true).optional(),
    dueAt: at.nullable(),
    idealDueAt: at.nullable(),
    firstSeenAt: at.nullable(),
    lastReviewAt: at.nullable(),
    reviewCount: count,
    meaning: ability.nullable(),
    spelling: ability.nullable(),
  })
  .strict();
const estimation = z
  .object({
    model: z.literal('FSRS-6'),
    label: z.literal('estimated'),
    futureAssumption: z.literal('no-additional-reviews'),
    historyBasis: z.literal('current-saved-evidence'),
  })
  .strict();
const response = z
  .object({
    schemaVersion: z.literal(1),
    revision: count,
    asOf: at,
    timezone,
    from: at,
    to: at,
    estimation,
    notices: z.array(z.string()),
  })
  .strict();
export const miniMemoryOverviewSchema = response.extend({
  summary: z
    .object({
      wordCount: count,
      completedWordCount: count,
      measuredWordCount: count,
      dueCount: count,
      overdueCount: count.optional(),
      scheduledCount: count,
      learningCount: count,
      excludedLegacyCount: count,
    })
    .strict(),
  words: z.array(miniMemoryWordSchema),
  load: z.array(z.object({ day: z.string(), at, count }).strict()).max(735),
});
export const miniMemoryDetailSchema = response.extend({
  word: miniMemoryWordSchema,
  points: z
    .array(
      z
        .object({
          at,
          meaning: probability.nullable(),
          spelling: probability.nullable(),
          meaningSegment: z.string().nullable(),
          spellingSegment: z.string().nullable(),
          projected: z.boolean(),
        })
        .strict(),
    )
    .max(300),
  events: z
    .array(
      z
        .object({
          id: z.string(),
          kind: z.enum(['completion', 'review', 'assessment', 'probe']),
          occurredAt: at,
          recordedAt: at,
          evidence: z.enum(['learning', 'self_report', 'objective', 'model']),
          meaning: z.enum(['Again', 'Hard', 'Good']).nullable(),
          spelling: z.enum(['Again', 'Hard', 'Good']).nullable(),
          reasons: z.array(z.string()),
        })
        .strict(),
    )
    .max(500),
  downsampled: z.boolean(),
  eventsTruncated: z.boolean(),
});
export type MiniMemoryOverviewInput = z.infer<typeof miniMemoryOverviewInputSchema>;
export type MiniMemoryDetailInput = z.infer<typeof miniMemoryDetailInputSchema>;
export type MiniMemoryWord = z.infer<typeof miniMemoryWordSchema>;
export type MiniMemoryOverview = z.infer<typeof miniMemoryOverviewSchema>;
export type MiniMemoryDetail = z.infer<typeof miniMemoryDetailSchema>;
