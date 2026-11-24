import { z } from 'zod';

const count = z.number().int().nonnegative();

export const miniDataStorageKindSchema = z.enum([
  'learning',
  'ai',
  'audioIndex',
  'audioFiles',
  'vocabulary',
  'materials',
  'serviceLog',
  'other',
]);

export const miniDataOverviewSchema = z.object({
  schemaVersion: z.literal(1),
  asOf: z.number().finite(),
  dataPath: z.string().min(1),
  learning: z.object({
    completedWords: count,
    reviewVisits: count,
    studyDays: count,
    events: count,
    translations: count,
  }),
  ai: z.object({
    conversations: count,
    messages: count,
    completedAssessments: count,
    pendingAssessments: count,
    failedAssessments: count,
  }),
  audio: z.object({
    wordAssets: count,
    sentenceAssets: count,
    currentAssets: count,
    previousAssets: count,
    missingFiles: count,
    unreferencedFiles: count,
    pendingJobs: count,
    failedJobs: count,
  }),
  vocabulary: z.object({ books: count, entries: count }),
  storage: z.array(z.object({ kind: miniDataStorageKindSchema, bytes: count })),
});

export type MiniDataOverview = z.infer<typeof miniDataOverviewSchema>;
export type MiniDataStorageKind = z.infer<typeof miniDataStorageKindSchema>;
