import { z } from 'zod';
import { miniTimezoneSchema, miniWordSchema } from './mini.js';

export const miniAiKindSchema = z.enum(['prepare', 'writing', 'feedback', 'advisor']);
export const miniAiEffortSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
const at = z.number().finite();
const uuid = z.uuid().toLowerCase();
export const miniAiStartSchema = z
  .object({
    requestId: uuid,
    kind: miniAiKindSchema,
    timezone: miniTimezoneSchema,
    dayId: z.string().max(200).optional(),
    attemptId: uuid.optional(),
    word: miniWordSchema.optional(),
    conversationId: z.string().min(1).max(200).default('advisor'),
    message: z.string().trim().min(1).max(8000).optional(),
    model: z.string().min(1).max(200).default('gpt-6.1-sol'),
    effort: miniAiEffortSchema.default('xhigh'),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.kind !== 'advisor' && !input.dayId)
      ctx.addIssue({ code: 'custom', message: 'dayId is required' });
    if (input.kind === 'feedback' && !input.attemptId)
      ctx.addIssue({ code: 'custom', message: 'attemptId is required' });
    if (input.kind === 'advisor' && !input.message)
      ctx.addIssue({ code: 'custom', message: 'message is required' });
  });
export type MiniAiStart = z.infer<typeof miniAiStartSchema>;
export const miniAiReceiptSchema = z
  .object({
    requestId: uuid,
    tool: z.string(),
    revision: z.number().int().nonnegative(),
    summary: z.string(),
  })
  .strict();
export const miniAiJobSchema = z
  .object({
    id: uuid,
    requestId: uuid,
    kind: miniAiKindSchema,
    status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']),
    dayId: z.string().optional(),
    attemptId: uuid.optional(),
    conversationId: z.string(),
    model: z.string(),
    effort: miniAiEffortSchema,
    progress: z.string(),
    text: z.string(),
    receipts: z.array(miniAiReceiptSchema),
    error: z.string().nullable(),
    createdAt: at,
    updatedAt: at,
    threadId: z.string().nullable(),
  })
  .strict();
export type MiniAiJob = z.infer<typeof miniAiJobSchema>;
export const miniAiMessageSchema = z
  .object({
    id: uuid,
    conversationId: z.string(),
    role: z.enum(['user', 'assistant']),
    text: z.string(),
    createdAt: at.nullable(),
    jobId: uuid.nullable(),
  })
  .strict();
export type MiniAiMessage = z.infer<typeof miniAiMessageSchema>;
export const miniAiConversationSchema = z
  .object({ id: z.string(), title: z.string(), word: miniWordSchema.nullable() })
  .strict();
export const miniAiSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    imported: z.boolean(),
    conversations: z.array(miniAiConversationSchema),
    messages: z.array(miniAiMessageSchema),
    jobs: z.array(miniAiJobSchema),
  })
  .strict();
export type MiniAiSnapshot = z.infer<typeof miniAiSnapshotSchema>;
export const miniAiControlSchema = z.object({ requestId: uuid, jobId: uuid }).strict();
export const miniAiImportSchema = z
  .object({
    requestId: uuid,
    conversations: z.array(
      z
        .object({
          id: z.string().min(1).max(200),
          title: z.string().max(500),
          word: miniWordSchema.nullable(),
          messages: z.array(
            z
              .object({
                id: uuid,
                role: z.enum(['user', 'assistant']),
                text: z.string().max(100000),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();
export type MiniAiImport = z.infer<typeof miniAiImportSchema>;
export const miniAiClearSchema = z
  .object({ requestId: uuid, conversationId: z.string().min(1).max(200) })
  .strict();
