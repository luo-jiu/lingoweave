import { z } from 'zod';

export const lexiconSourceSchema = z.object({
  name: z.string().min(1),
  url: z.url(),
  license: z.string().min(1),
  version: z.string().min(1),
});

export const lexiconWordSchema = z.object({
  id: z.string().min(1),
  lemma: z.string().min(1),
  partOfSpeech: z.string().min(1),
  meaningZh: z.string().min(1),
  phonetic: z.string().nullable(),
  sources: z.array(lexiconSourceSchema).min(1),
});
export type LexiconWord = z.infer<typeof lexiconWordSchema>;

export const preparationStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export const preparationJobSchema = z.object({
  id: z.string(),
  groupId: z.string(),
  attempt: z.number().int().positive(),
  status: preparationStatusSchema,
  model: z.string().nullable(),
  threadId: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PreparationJob = z.infer<typeof preparationJobSchema>;

export const materialInputSchema = z
  .object({
    wordId: z.string().min(1).max(200),
    english: z.string().trim().min(3).max(250),
    chinese: z.string().trim().min(1).max(250),
  })
  .strict();
export const publishMaterialsSchema = z
  .object({
    requestId: z.string().min(1).max(100),
    materials: z.array(materialInputSchema).length(5),
  })
  .strict();
export type PublishMaterialsInput = z.infer<typeof publishMaterialsSchema>;

export const learningMaterialSchema = materialInputSchema.extend({
  source: z.literal('ai-generated'),
  jobId: z.string(),
  createdAt: z.iso.datetime(),
});
export type LearningMaterial = z.infer<typeof learningMaterialSchema>;

export const learningGroupSchema = z.object({
  id: z.string(),
  title: z.string(),
  wordIds: z.array(z.string()),
  stage: z.enum(['preparing', 'ready']),
  createdAt: z.iso.datetime(),
});
export type LearningGroup = z.infer<typeof learningGroupSchema>;

export const preparationMessageSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  text: z.string(),
  status: z.enum(['streaming', 'complete', 'interrupted']),
});
export const workspaceSnapshotSchema = z.object({
  group: learningGroupSchema.nullable(),
  words: z.array(lexiconWordSchema),
  lexiconSize: z.number().int().nonnegative(),
  materials: z.array(learningMaterialSchema),
  job: preparationJobSchema.nullable(),
  messages: z.array(preparationMessageSchema),
  lastEventSeq: z.number().int().nonnegative(),
});
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;

export const workspaceEventSchema = z.object({
  seq: z.number().int().positive(),
  jobId: z.string(),
  kind: z.enum(['job', 'message', 'materials']),
  timestamp: z.iso.datetime(),
});
export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>;

export const runtimeStatusSchema = z.object({
  available: z.boolean(),
  authenticated: z.boolean(),
  version: z.string().nullable(),
  models: z.array(z.object({ id: z.string(), name: z.string(), isDefault: z.boolean() })),
  error: z.string().nullable(),
});
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;

export const prepareRequestSchema = z
  .object({
    requestId: z.uuid(),
    model: z.string().min(1).max(100).optional(),
  })
  .strict();
export const cancelRequestSchema = z.object({ requestId: z.uuid() }).strict();
export const preparationReceiptSchema = z.object({ jobId: z.string(), reused: z.boolean() });
