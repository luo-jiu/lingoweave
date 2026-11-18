import { z } from 'zod';

const at = z.number().finite();
const word = z.object({ spelling: z.string(), meaning: z.string(), phonetic: z.string() }).strict();
const rating = z.enum(['Again', 'Hard', 'Good']).nullable();
const card = z
  .object({
    due: at,
    stability: z.number().nonnegative(),
    difficulty: z.number().nonnegative(),
    elapsed_days: z.number().nonnegative(),
    scheduled_days: z.number().nonnegative(),
    learning_steps: z.number().int().nonnegative(),
    reps: z.number().int().nonnegative(),
    lapses: z.number().int().nonnegative(),
    state: z.number().int().min(0).max(3),
    last_review: at.optional(),
  })
  .strict();
export const miniFlowScheduleEventSchema = z
  .object({
    id: z.string().min(1),
    word,
    kind: z.enum(['completion', 'review', 'assessment', 'probe']),
    sourceId: z.string(),
    occurredAt: at,
    recordedAt: at,
    timezone: z.string(),
    meaning: rating,
    spelling: rating,
    evidence: z.enum(['learning', 'self_report', 'objective', 'model']),
    nextDay: z.boolean(),
    reviewCeilingDays: z.union([z.literal(1), z.literal(2)]).optional(),
    reasons: z.array(z.string()),
    load: z.record(z.string(), z.number().int().nonnegative()).default({}),
  })
  .strict();
export const miniFlowScheduleCardSchema = z
  .object({
    senseId: z.string(),
    word,
    meaning: card.nullable(),
    spelling: card.nullable(),
    dueAt: at,
    idealDueAt: at,
    updatedAt: at,
    lastEventId: z.string(),
    reasons: z.array(z.string()),
  })
  .strict();
export const miniFlowSchedulingSchema = z
  .object({
    policyVersion: z.literal('mini-flow-scheduling-v1'),
    libraryVersion: z.literal('ts-fsrs@5.4.2/FSRS-6'),
    events: z.array(miniFlowScheduleEventSchema),
    cards: z.array(miniFlowScheduleCardSchema),
    changes: z.array(
      z
        .object({
          id: z.string(),
          recordedAt: at,
          eventId: z.string(),
          word,
          before: miniFlowScheduleCardSchema.nullable(),
          after: miniFlowScheduleCardSchema,
          reason: z.string(),
          parameters: z
            .object({
              retention: z.literal(0.9),
              weights: z.array(z.number()).length(21),
              learningSteps: z.array(z.string()),
              relearningSteps: z.array(z.string()),
              fuzzPolicy: z.literal('bounded-load-v1'),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict();
export type MiniFlowScheduleEvent = z.infer<typeof miniFlowScheduleEventSchema>;
export type MiniFlowScheduleCard = z.infer<typeof miniFlowScheduleCardSchema>;
export type MiniFlowScheduling = z.infer<typeof miniFlowSchedulingSchema>;
export function defaultMiniFlowScheduling(): MiniFlowScheduling {
  return {
    policyVersion: 'mini-flow-scheduling-v1',
    libraryVersion: 'ts-fsrs@5.4.2/FSRS-6',
    events: [],
    cards: [],
    changes: [],
  };
}
