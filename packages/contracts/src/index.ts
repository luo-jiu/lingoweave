import { z } from 'zod';
export * from './mini-vocabulary.js';

export * from './learning.js';
export * from './mini.js';
export * from './mini-assessment.js';
export * from './mini-flow-scheduling.js';
export * from './mini-memory.js';
export * from './mini-ai.js';
export * from './mini-audio.js';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('lingoweave-api'),
  version: z.string(),
  timestamp: z.iso.datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
