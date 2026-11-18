import { z } from 'zod';
import { miniWordSchema } from './mini.js';

const identifier = z
  .string()
  .regex(/^[a-z0-9][a-z0-9:_-]*$/)
  .max(160);
export const miniVocabularyLevelSchema = z.enum(['A1', 'A2', 'B1', 'B2']);
export const miniVocabularyOrderSchema = z.enum(['random', 'source']);
export const miniVocabularySourceSchema = z
  .object({
    id: identifier,
    title: z.string().min(1).max(300),
    url: z.url(),
    version: z.string().min(1).max(200),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    license: z.string().min(1).max(1000),
    role: z.enum(['wordlist', 'dictionary']),
  })
  .strict();
export const miniVocabularyEntrySchema = z
  .object({
    id: identifier,
    word: miniWordSchema,
    level: miniVocabularyLevelSchema.nullable().default(null),
    partOfSpeech: z.string().max(150),
    sourceEntry: z.string().min(1).max(500),
    rank: z.number().int().nonnegative(),
  })
  .strict();
export const miniVocabularyDeckSchema = z
  .object({
    id: identifier,
    name: z.string().min(1).max(200),
    wordCount: z.number().int().nonnegative(),
    level: miniVocabularyLevelSchema.nullable(),
    bookId: identifier.optional(),
  })
  .strict();
export const miniVocabularyBookSchema = z
  .object({
    id: identifier,
    name: z.string().min(1).max(200),
    wordCount: z.number().int().nonnegative(),
    levels: z.array(
      z
        .object({
          level: miniVocabularyLevelSchema,
          deckId: identifier,
          wordCount: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();
export const miniVocabularySnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    activeDeckId: identifier.nullable(),
    activeOrder: miniVocabularyOrderSchema.default('random'),
    decks: z.array(miniVocabularyDeckSchema),
    books: z.array(miniVocabularyBookSchema).default([]),
    activeWords: z.array(miniWordSchema).max(10_000),
    sources: z.array(miniVocabularySourceSchema),
  })
  .strict();
export const miniVocabularyImportSchema = z
  .object({
    requestId: z.uuid().toLowerCase(),
    expectedRevision: z.number().int().nonnegative(),
    id: identifier,
    name: z.string().min(1).max(200),
    entries: z.array(miniVocabularyEntrySchema).min(1).max(10_000),
    sources: z.array(miniVocabularySourceSchema).min(2).max(10),
    activate: z.boolean().default(false),
  })
  .strict();
export const miniVocabularyActivateSchema = z
  .object({
    requestId: z.uuid().toLowerCase(),
    expectedRevision: z.number().int().nonnegative(),
    deckId: identifier.nullable(),
    order: miniVocabularyOrderSchema.optional(),
  })
  .strict();

export type MiniVocabularySource = z.infer<typeof miniVocabularySourceSchema>;
export type MiniVocabularyOrder = z.infer<typeof miniVocabularyOrderSchema>;
export type MiniVocabularyBook = z.infer<typeof miniVocabularyBookSchema>;
export type MiniVocabularyEntry = z.infer<typeof miniVocabularyEntrySchema>;
export type MiniVocabularySnapshot = z.infer<typeof miniVocabularySnapshotSchema>;
export type MiniVocabularyImport = z.infer<typeof miniVocabularyImportSchema>;
export type MiniVocabularyActivate = z.infer<typeof miniVocabularyActivateSchema>;
