import { z } from 'zod';

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
export const miniAiSelectionSchema = z
  .object({ model: z.string().min(1).max(200), effort: miniAiEffortSchema })
  .strict();
export const defaultMiniAiSelection = {
  model: 'gpt-6.1-sol',
  effort: 'xhigh',
} as const satisfies z.infer<typeof miniAiSelectionSchema>;
