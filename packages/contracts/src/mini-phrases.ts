import { z } from 'zod';

export const miniPhraseKindSchema = z.enum(['pattern', 'focus', 'sentence', 'feedback']);
export const miniPhraseQuerySchema = z
  .object({
    q: z.string().trim().max(200).default(''),
    kind: miniPhraseKindSchema.optional(),
    offset: z.coerce.number().int().nonnegative().safe().default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type MiniPhraseQuery = z.infer<typeof miniPhraseQuerySchema>;
export const miniPhraseEntrySchema = z
  .object({
    id: z.string(),
    kind: miniPhraseKindSchema,
    status: z.enum(['viewed', 'attempted', 'practiced', 'encountered', 'feedback']),
    expression: z.string(),
    explanation: z.string().nullable(),
    exampleEnglish: z.string().nullable(),
    exampleChinese: z.string().nullable(),
    words: z.array(z.string()),
    lastSeenAt: z.number().finite(),
  })
  .strict();
export type MiniPhraseEntry = z.infer<typeof miniPhraseEntrySchema>;
export const miniPhrasePageSchema = z
  .object({ total: z.number().int().nonnegative(), items: z.array(miniPhraseEntrySchema).max(100) })
  .strict();
export type MiniPhrasePage = z.infer<typeof miniPhrasePageSchema>;
