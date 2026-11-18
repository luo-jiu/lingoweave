import { z } from 'zod';

const uuid = z.uuid().toLowerCase();
const at = z.number().finite();
const word = z.object({ spelling: z.string(), meaning: z.string(), phonetic: z.string() }).strict();

export const miniAssessmentDiscussionSchema = z
  .object({
    id: uuid,
    role: z.enum(['user', 'assistant']),
    text: z.string().max(100000),
    occurredAt: at,
    relation: z.enum(['before_answer', 'after_answer']),
  })
  .strict();

/** Created by the learning transaction, never supplied by the model or learner. */
export const miniAssessmentSourceSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: uuid,
    dayId: z.string().min(1),
    attemptId: uuid,
    word,
    timezone: z.string().min(1),
    question: z
      .object({
        id: z.string().min(1).max(1000),
        direction: z.enum(['englishToChinese', 'chineseToEnglish']),
        english: z.string(),
        chinese: z.string(),
      })
      .strict(),
    answer: z.string(),
    submittedAt: at,
    confirmedAt: at,
    // These are immutable projections of already validated learning records.
    // JSON values allow old and new flow versions to keep their original evidence.
    learningEvidence: z.record(z.string(), z.json()),
    discussion: z.array(miniAssessmentDiscussionSchema).default([]),
  })
  .strict();
export type MiniAssessmentSource = z.infer<typeof miniAssessmentSourceSchema>;

export const miniAssessmentObservationSchema = z
  .object({
    outcome: z
      .enum(['correct', 'incorrect', 'not_tested', 'uncertain'])
      .describe(
        'Judge the original answer in this dimension. Lack of independent-recall eligibility is not semantic uncertainty. Untested dimensions are not_tested.',
      ),
    explanation: z.string().trim().min(1).max(2000),
    evidenceIds: z.array(z.string().min(1).max(200)).max(30),
  })
  .strict();
export const miniAssessmentResultSchema = z
  .object({
    sourceId: uuid,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    meaning: miniAssessmentObservationSchema,
    spelling: miniAssessmentObservationSchema,
    usage: miniAssessmentObservationSchema,
    summary: z.string().trim().min(1).max(3000),
    strengths: z.array(z.string().max(1000)).max(10),
    improvements: z.array(z.string().max(1000)).max(10),
    referenceTranslation: z.string().max(6000),
    uncertainties: z
      .array(z.string().max(1000))
      .max(10)
      .describe(
        'Actual missing information or ambiguity affecting an uncertain target dimension. A nonempty list requires at least one observation outcome uncertain. Do not put recent exposure, supported practice, untested abilities, or lack of proof of long-term retention here; explain those as qualifications in explanation instead.',
      ),
  })
  .strict();
export type MiniAssessmentResult = z.infer<typeof miniAssessmentResultSchema>;

export const miniAssessmentTraceSchema = z
  .object({
    model: z.string(),
    effort: z.literal('xhigh'),
    threadId: z.string().nullable(),
    rulesVersion: z.literal('mini-assessment-v1'),
    skillHash: z.string().regex(/^[a-f0-9]{64}$/),
    promptHash: z.string().regex(/^[a-f0-9]{64}$/),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    startedAt: at,
    assessedAt: at,
  })
  .strict();
export type MiniAssessmentTrace = z.infer<typeof miniAssessmentTraceSchema>;

export const miniAssessmentApplicationSchema = z
  .object({
    requestId: uuid,
    source: miniAssessmentSourceSchema,
    result: miniAssessmentResultSchema,
    trace: miniAssessmentTraceSchema,
  })
  .strict();
export type MiniAssessmentApplication = z.infer<typeof miniAssessmentApplicationSchema>;

export const miniAssessmentReceiptSchema = z
  .object({
    requestId: uuid,
    sourceId: uuid,
    revision: z.number().int().nonnegative(),
    disposition: z.enum(['adopted', 'partially_adopted', 'pending_review', 'rejected']),
    reason: z.string(),
    scheduling: z.record(z.string(), z.json()),
  })
  .strict();
export type MiniAssessmentReceipt = z.infer<typeof miniAssessmentReceiptSchema>;

export const miniAssessmentJobSchema = z
  .object({
    id: uuid,
    sourceId: uuid,
    dayId: z.string(),
    attemptId: uuid,
    word,
    status: z.enum(['queued', 'running', 'completed', 'failed']),
    createdAt: at,
    updatedAt: at,
    retryCount: z.number().int().nonnegative(),
    error: z.string().nullable(),
    receipt: miniAssessmentReceiptSchema.nullable(),
  })
  .strict();
export type MiniAssessmentJob = z.infer<typeof miniAssessmentJobSchema>;

export const miniAssessmentSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    pendingCount: z.number().int().nonnegative(),
    runningCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    jobs: z.array(miniAssessmentJobSchema),
  })
  .strict();
export type MiniAssessmentSnapshot = z.infer<typeof miniAssessmentSnapshotSchema>;
export const miniAssessmentDetailSchema = z
  .object({
    job: miniAssessmentJobSchema,
    source: miniAssessmentSourceSchema,
    application: miniAssessmentApplicationSchema.nullable(),
  })
  .strict();
export type MiniAssessmentDetail = z.infer<typeof miniAssessmentDetailSchema>;
export const miniAssessmentRetrySchema = z.object({ requestId: uuid, jobId: uuid }).strict();
export const miniAssessmentCommitSchema = z
  .object({ requestId: uuid, result: miniAssessmentResultSchema })
  .strict();
