import { z } from 'zod';
import { miniExpressionGradeSchema } from './mini-assessment.js';
import { miniTimezoneSchema, miniTranslationTaskSchema, miniWordSchema } from './mini.js';

export const miniTranslationReviewQuerySchema = z
  .object({ date: z.iso.date(), timezone: miniTimezoneSchema })
  .strict();
export type MiniTranslationReviewQuery = z.infer<typeof miniTranslationReviewQuerySchema>;

const commentary = z
  .object({
    summary: z.string(),
    strengths: z.array(z.string()),
    improvements: z.array(z.string()),
    keyPoints: z.array(z.string()),
    referenceTranslation: z.string(),
  })
  .strict();

export const miniTranslationReviewSchema = miniTranslationReviewQuerySchema.extend({
  entries: z.array(
    z
      .object({
        attemptId: z.uuid(),
        // The row stays with the initial submission; feedback belongs to this version.
        answerRevisionId: z.uuid().optional(),
        dayId: z.string(),
        word: miniWordSchema,
        direction: miniTranslationTaskSchema.shape.direction,
        question: z.string(),
        answer: z.string(),
        submittedAt: z.number().finite(),
        status: z.enum(['submitted', 'queued', 'running', 'failed', 'ready']),
        commentary: commentary.nullable(),
        expressionGrade: miniExpressionGradeSchema.optional(),
        expressionGradeStatus: z.enum(['queued', 'failed']).optional(),
        retryJobId: z.uuid().nullable(),
      })
      .strict(),
  ),
});
export type MiniTranslationReview = z.infer<typeof miniTranslationReviewSchema>;
