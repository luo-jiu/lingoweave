import { z } from 'zod';
import { miniSentenceSchema, miniWordSchema } from './mini.js';

const uuid = z.uuid().toLowerCase();
const at = z.number().finite(); // Swift seconds since 2001-01-01, matching mini facts.
export const miniAudioVoiceSchema = z.enum(['ryan', 'aiden', 'serena']);
export type MiniAudioVoice = z.infer<typeof miniAudioVoiceSchema>;
export const miniAudioTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('word'), word: miniWordSchema }).strict(),
  z
    .object({
      kind: z.literal('sentence'),
      sentence: miniSentenceSchema.safeExtend({
        english: z.string().trim().min(1).max(1000),
        chinese: z.string().max(5000),
      }),
    })
    .strict(),
]);
export type MiniAudioTarget = z.infer<typeof miniAudioTargetSchema>;
export const miniAudioRequestSchema = z
  .object({
    requestId: uuid,
    target: miniAudioTargetSchema,
    operation: z.enum(['ensure', 'regenerate']).default('ensure'),
    voice: miniAudioVoiceSchema.optional(),
  })
  .strict();
export type MiniAudioRequest = z.infer<typeof miniAudioRequestSchema>;
export const miniAudioProfileSchema = z
  .object({
    modelId: z.string().min(1),
    modelRevision: z.string().min(1),
    engine: z.literal('mlx-audio'),
    engineVersion: z.string().min(1),
    generationVersion: z.string().min(1),
    language: z.literal('English'),
    temperature: z.number().min(0).max(2),
    maxTokens: z.number().int().positive(),
  })
  .strict();
export type MiniAudioProfile = z.infer<typeof miniAudioProfileSchema>;
export const miniAudioAssetSchema = z
  .object({
    id: uuid,
    targetKey: z.string().min(1),
    target: miniAudioTargetSchema,
    text: z.string(),
    normalizedText: z.string(),
    language: z.literal('English'),
    voice: miniAudioVoiceSchema,
    profile: miniAudioProfileSchema,
    instructions: z.string(),
    fileName: z.string().regex(/^[a-z0-9-]+\.wav$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive(),
    sampleRate: z.number().int().positive(),
    channels: z.number().int().positive(),
    durationSeconds: z.number().positive(),
    createdAt: at,
  })
  .strict();
export type MiniAudioAsset = z.infer<typeof miniAudioAssetSchema>;
export const miniAudioJobSchema = z
  .object({
    id: uuid,
    requestId: uuid,
    targetKey: z.string(),
    target: miniAudioTargetSchema,
    operation: z.enum(['ensure', 'regenerate']),
    voice: miniAudioVoiceSchema,
    status: z.enum(['queued', 'running', 'completed', 'failed', 'interrupted']),
    progress: z.string(),
    error: z.string().nullable(),
    assetId: uuid.nullable(),
    createdAt: at,
    updatedAt: at,
  })
  .strict();
export type MiniAudioJob = z.infer<typeof miniAudioJobSchema>;
export const miniAudioResultSchema = z
  .object({
    targetKey: z.string(),
    asset: miniAudioAssetSchema.nullable(),
    job: miniAudioJobSchema.nullable(),
    reused: z.boolean(),
  })
  .strict();
export type MiniAudioResult = z.infer<typeof miniAudioResultSchema>;
export const miniAudioRuntimeSchema = z
  .object({
    available: z.boolean(),
    profile: miniAudioProfileSchema.nullable(),
    error: z.string().nullable(),
  })
  .strict();
export type MiniAudioRuntime = z.infer<typeof miniAudioRuntimeSchema>;
export const miniAudioContextSchema = z.discriminatedUnion('target', [
  z
    .object({
      target: z.literal('daily'),
      dayId: z.string().min(1),
      session: z.enum(['review', 'learning']).optional(),
      taskId: z.string().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      target: z.literal('review'),
      recordId: uuid,
      session: z.literal('review').optional(),
    })
    .strict(),
]);
export type MiniAudioContext = z.infer<typeof miniAudioContextSchema>;
export const miniAudioPlaybackSchema = z
  .object({
    requestId: uuid,
    assetId: uuid,
    visitId: uuid,
    mode: z.enum(['automatic', 'manual']),
    context: miniAudioContextSchema.optional(),
    spellingSubmissionId: uuid.optional(),
  })
  .strict();
export type MiniAudioPlayback = z.infer<typeof miniAudioPlaybackSchema>;
export const miniAudioPlaybackStartSchema = z
  .object({
    requestId: uuid,
    playbackId: uuid,
    occurredAt: at,
  })
  .strict();
export type MiniAudioPlaybackStart = z.infer<typeof miniAudioPlaybackStartSchema>;
export const miniAudioPlaybackReceiptSchema = z
  .object({
    id: uuid,
    requestId: uuid,
    assetId: uuid,
    visitId: uuid,
    status: z.enum(['authorized', 'started']),
    authorizedAt: at,
    startedAt: at.nullable(),
    learningRevision: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type MiniAudioPlaybackReceipt = z.infer<typeof miniAudioPlaybackReceiptSchema>;
export const miniAudioSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    assets: z.array(miniAudioAssetSchema),
    jobs: z.array(miniAudioJobSchema),
    playbacks: z.array(miniAudioPlaybackReceiptSchema),
  })
  .strict();
export type MiniAudioSnapshot = z.infer<typeof miniAudioSnapshotSchema>;
