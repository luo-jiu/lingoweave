import { z } from 'zod';
import { miniTimezoneSchema } from './mini.js';

export const miniPatternLevelSchema = z.enum(['A1', 'A2']);
export type MiniPatternLevel = z.infer<typeof miniPatternLevelSchema>;
export const miniPatternCardSchema = z
  .object({
    id: z.string(),
    level: miniPatternLevelSchema,
    frame: z.string(),
    meaning: z.string(),
    example: z.string(),
    translation: z.string(),
    cue: z.string(),
    substitution: z.string(),
  })
  .strict();
export type MiniPatternCard = z.infer<typeof miniPatternCardSchema>;
export const miniPatternQuerySchema = z.object({ timezone: miniTimezoneSchema }).strict();
export const miniPatternViewSchema = miniPatternQuerySchema.extend({
  batchId: z.string().min(1).max(200),
  patternId: z.string().min(1).max(120),
});
export type MiniPatternView = z.infer<typeof miniPatternViewSchema>;
export const miniPatternSnapshotSchema = z
  .object({
    date: z.iso.date(),
    level: miniPatternLevelSchema,
    batchId: z.string(),
    batch: z.array(miniPatternCardSchema).max(5),
    completedIds: z.array(z.string()).max(5),
    canDialogue: z.boolean(),
    practicedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
  })
  .strict();
export type MiniPatternSnapshot = z.infer<typeof miniPatternSnapshotSchema>;
export const miniPatternPracticeSchema = z
  .object({
    requestId: z.uuid().toLowerCase(),
    timezone: miniTimezoneSchema,
    batchId: z.string().min(1).max(200),
    patternId: z.string().min(1).max(120),
    answer: z.string().trim().min(1).max(800),
    usedHint: z.boolean(),
    continueAfterFeedback: z.boolean().optional(),
  })
  .strict();
export type MiniPatternPractice = z.infer<typeof miniPatternPracticeSchema>;
export const miniPatternResultSchema = z
  .object({
    correct: z.boolean(),
    reference: z.string(),
    snapshot: miniPatternSnapshotSchema,
  })
  .strict();
export type MiniPatternResult = z.infer<typeof miniPatternResultSchema>;
