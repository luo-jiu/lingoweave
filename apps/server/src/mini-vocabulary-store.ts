import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  miniVocabularyActivateSchema,
  miniVocabularyEntrySchema,
  miniVocabularyImportSchema,
  miniVocabularyOrderSchema,
  miniVocabularySourceSchema,
  miniVocabularySnapshotSchema,
  type MiniVocabularyActivate,
  type MiniVocabularyImport,
  type MiniVocabularyOrder,
  type MiniVocabularySnapshot,
  type MiniWord,
  type MiniLedger,
} from '@lingoweave/contracts';
import { LearningError } from './learning-store.js';
import { wordKey } from './mini-study.js';

const collectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  entries: z.array(miniVocabularyEntrySchema),
  sources: z.array(miniVocabularySourceSchema),
});
const stateSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  activeDeckId: z.string().nullable(),
  activeOrder: miniVocabularyOrderSchema.default('random'),
  collections: z.array(collectionSchema),
});
type State = z.infer<typeof stateSchema>;
const levels = ['A1', 'A2', 'B1', 'B2'] as const;
const bodySchema = z.object({ body: z.string() });

type BookIndex = { id: string; keys: ReadonlySet<string> };

export function miniCompletedWordKeys(ledger: MiniLedger) {
  const learned = new Set<string>();
  for (const day of ledger.days) {
    if (day.flow) {
      for (const item of day.flow.completed) learned.add(wordKey(item.word));
    } else if (day.phase === 'finished') {
      for (const word of day.learningWords) learned.add(wordKey(word));
    } else if (day.translationIndex > 0) {
      // Legacy days advanced each translation index after feedback and explicit confirmation.
      const newWords = new Set(day.learningWords.map(wordKey));
      for (const attempt of day.translation.slice(0, day.translationIndex)) {
        const key = wordKey(attempt.task.sentence.word);
        if (newWords.has(key)) learned.add(key);
      }
    }
  }
  return learned;
}
export function miniWordProgress(ledger: MiniLedger, deck: MiniWord[], book?: BookIndex | null) {
  const learned = miniCompletedWordKeys(ledger);
  const keys = book?.keys ?? new Set(deck.map(wordKey));
  let completed = 0;
  for (const key of learned) if (keys.has(key)) completed++;
  return { lifetime: learned.size, bookId: book?.id ?? null, completed, total: keys.size };
}

function words(
  collection: z.infer<typeof collectionSchema>,
  level: string | null,
  order: MiniVocabularyOrder,
): MiniWord[] {
  const selected = new Map<string, z.infer<typeof miniVocabularyEntrySchema>>();
  const entries = [...collection.entries].sort((left, right) => left.rank - right.rank);
  for (const entry of entries) {
    if (level !== null && entry.level !== level) continue;
    if (!selected.has(wordKey(entry.word))) selected.set(wordKey(entry.word), entry);
  }
  if (order === 'source') return [...selected.values()].map((entry) => entry.word);
  // Source order selects the canonical entry before its stable shuffle is applied.
  return [...selected.values()]
    .map((entry) => ({
      entry,
      shuffleKey: createHash('sha256')
        .update(JSON.stringify(['mini-vocabulary-order-v1', collection.id, entry.id]))
        .digest('hex'),
    }))
    .sort((left, right) => left.shuffleKey.localeCompare(right.shuffleKey))
    .map(({ entry }) => entry.word);
}

export class MiniVocabularyStore {
  private readonly db: DatabaseSync;
  private closed = false;
  private bookIndex?: { version: number; book: BookIndex | null };

  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    try {
      if (filename !== ':memory:') chmodSync(filename, 0o600);
      const version = z
        .object({ user_version: z.number().int() })
        .parse(this.db.prepare('PRAGMA user_version').get()).user_version;
      if (version > 1) throw new Error('Vocabulary was created by a newer LingoWeave version.');
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS vocabulary_state(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS vocabulary_requests(id TEXT PRIMARY KEY,hash TEXT NOT NULL);
        PRAGMA user_version=1;`);
      this.db
        .prepare('INSERT OR IGNORE INTO vocabulary_state(id,body) VALUES(1,?)')
        .run(
          JSON.stringify({ schemaVersion: 1, revision: 0, activeDeckId: null, collections: [] }),
        );
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const state = this.state();
        const activeBook = state.collections.some(
          (collection) => collection.id === state.activeDeckId,
        )
          ? undefined
          : state.collections.find((collection) =>
              levels.some(
                (level) =>
                  state.activeDeckId === `${collection.id}-${level.toLowerCase()}` &&
                  !collection.entries.some((entry) => entry.level === level),
              ),
            );
        if (activeBook) {
          state.activeDeckId = activeBook.id;
          state.revision++;
          this.db
            .prepare('UPDATE vocabulary_state SET body=? WHERE id=1')
            .run(JSON.stringify(state));
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private state(): State {
    return stateSchema.parse(
      JSON.parse(
        bodySchema.parse(this.db.prepare('SELECT body FROM vocabulary_state WHERE id=1').get())
          .body,
      ),
    );
  }

  dataMetrics() {
    const state = this.state();
    return {
      books: state.collections.length,
      entries: state.collections.reduce((sum, collection) => sum + collection.entries.length, 0),
    };
  }

  activeBookIndex() {
    // Plan previews are read after every card. Rebuild book membership only when vocabulary changes.
    const version = z
      .object({ data_version: z.number() })
      .parse(this.db.prepare('PRAGMA data_version').get()).data_version;
    if (this.bookIndex?.version === version) return this.bookIndex.book;
    const state = this.state();
    const collection =
      state.collections.find((item) => item.id === state.activeDeckId) ??
      state.collections.find((item) =>
        levels.some(
          (level) =>
            state.activeDeckId === item.id + '-' + level.toLowerCase() &&
            item.entries.some((entry) => entry.level === level),
        ),
      );
    const book = collection
      ? { id: collection.id, keys: new Set(collection.entries.map((entry) => wordKey(entry.word))) }
      : null;
    this.bookIndex = { version, book };
    return book;
  }

  snapshot(): MiniVocabularySnapshot {
    const state = this.state();
    const decks: MiniVocabularySnapshot['decks'] = [];
    const books: MiniVocabularySnapshot['books'] = [];
    const sources = new Map<string, MiniVocabularySnapshot['sources'][number]>();
    let activeWords: MiniWord[] = [];
    for (const collection of state.collections) {
      const all = words(collection, null, state.activeOrder);
      const orderLabel = state.activeOrder === 'random' ? '乱序' : '顺序';
      decks.push({
        id: collection.id,
        bookId: collection.id,
        name: collection.name + ' · 全部 · ' + orderLabel,
        wordCount: all.length,
        level: null,
      });
      const book: MiniVocabularySnapshot['books'][number] = {
        id: collection.id,
        name: collection.name,
        wordCount: all.length,
        levels: [],
      };
      if (state.activeDeckId === collection.id) activeWords = all;
      for (const level of levels) {
        const selected = words(collection, level, state.activeOrder);
        if (selected.length === 0) continue;
        const id = `${collection.id}-${level.toLowerCase()}`;
        decks.push({
          id,
          bookId: collection.id,
          name: `${collection.name} · ${level} · ${orderLabel}`,
          wordCount: selected.length,
          level,
        });
        book.levels.push({ level, deckId: id, wordCount: selected.length });
        if (state.activeDeckId === id) activeWords = selected;
      }
      books.push(book);
      for (const source of collection.sources) sources.set(source.id, source);
    }
    if (new Set(decks.map((deck) => deck.id)).size !== decks.length)
      throw new LearningError('VOCABULARY_INVALID', '词书身份与其他词书的等级身份重复。', 400);
    return miniVocabularySnapshotSchema.parse({
      schemaVersion: 1,
      revision: state.revision,
      activeDeckId: state.activeDeckId,
      activeOrder: state.activeOrder,
      decks,
      books,
      activeWords,
      sources: [...sources.values()],
    });
  }

  wordContext(word: MiniWord) {
    const spelling = word.spelling.normalize('NFKC').trim().toLowerCase();
    return this.state()
      .collections.flatMap((collection) =>
        collection.entries
          .filter(
            (entry) => entry.word.spelling.normalize('NFKC').trim().toLowerCase() === spelling,
          )
          .map((entry) => ({
            collectionId: collection.id,
            level: entry.level,
            partOfSpeech: entry.partOfSpeech,
            word: entry.word,
            sourceEntry: entry.sourceEntry,
          })),
      )
      .slice(0, 20);
  }

  lessonContext(targets: MiniWord[]) {
    const snapshot = this.snapshot();
    const keys = new Set(targets.map(wordKey));
    const targetsWithLevels = this.state()
      .collections.flatMap((collection) =>
        collection.entries
          .filter((entry) => keys.has(wordKey(entry.word)))
          .map((entry) => ({
            word: entry.word,
            level: entry.level,
            partOfSpeech: entry.partOfSpeech,
          })),
      )
      .slice(0, 20);
    return {
      activeDeck: snapshot.decks.find((deck) => deck.id === snapshot.activeDeckId) ?? null,
      targets: targetsWithLevels,
    };
  }

  private mutate(
    input: { requestId: string; expectedRevision: number },
    operation: (state: State) => void,
  ) {
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db
        .prepare('SELECT hash FROM vocabulary_requests WHERE id=?')
        .get(input.requestId);
      if (previous) {
        if (z.object({ hash: z.string() }).parse(previous).hash !== fingerprint)
          throw new LearningError('REQUEST_CONFLICT', '相同请求身份不能用于不同词库操作。');
      } else {
        const state = this.state();
        if (state.revision !== input.expectedRevision)
          throw new LearningError('VOCABULARY_REVISION_CONFLICT', '词库已更新，请刷新后重试。');
        const before = JSON.stringify(state);
        operation(state);
        if (JSON.stringify(state) !== before) {
          state.revision++;
          this.db
            .prepare('UPDATE vocabulary_state SET body=? WHERE id=1')
            .run(JSON.stringify(stateSchema.parse(state)));
        }
        this.db
          .prepare('INSERT INTO vocabulary_requests(id,hash) VALUES(?,?)')
          .run(input.requestId, fingerprint);
      }
      const snapshot = this.snapshot();
      this.db.exec('COMMIT');
      this.bookIndex = undefined;
      return snapshot;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  import(raw: MiniVocabularyImport): MiniVocabularySnapshot {
    const input = miniVocabularyImportSchema.parse(raw);
    const identifiers = new Set(input.entries.map((entry) => entry.id));
    if (identifiers.size !== input.entries.length)
      throw new LearningError('VOCABULARY_INVALID', '词表含重复条目身份。', 400);
    if (
      !input.sources.some((source) => source.role === 'wordlist') ||
      !input.sources.some((source) => source.role === 'dictionary')
    )
      throw new LearningError('VOCABULARY_INVALID', '请保留词表与词典的来源记录。', 400);
    if (input.entries.some((entry) => entry.word.meaning.trim().length === 0))
      throw new LearningError('VOCABULARY_INVALID', '学习词条需要可用释义。', 400);
    return this.mutate(input, (state) => {
      const collection = {
        id: input.id,
        name: input.name,
        entries: input.entries,
        sources: input.sources,
      };
      const index = state.collections.findIndex((item) => item.id === input.id);
      const previous = state.collections[index];
      const activeLevel = levels.find(
        (level) =>
          state.activeDeckId === `${input.id}-${level.toLowerCase()}` &&
          previous?.entries.some((entry) => entry.level === level),
      );
      if (index < 0) state.collections.push(collection);
      else state.collections[index] = collection;
      if (input.activate) state.activeDeckId = input.id;
      if (activeLevel && !input.entries.some((entry) => entry.level === activeLevel))
        state.activeDeckId = input.id;
    });
  }

  activate(raw: MiniVocabularyActivate): MiniVocabularySnapshot {
    const input = miniVocabularyActivateSchema.parse(raw);
    return this.mutate(input, (state) => {
      if (input.deckId !== null && !this.snapshot().decks.some((deck) => deck.id === input.deckId))
        throw new LearningError('VOCABULARY_NOT_FOUND', '找不到这套词库。', 404);
      state.activeDeckId = input.deckId;
      if (input.order !== undefined) state.activeOrder = input.order;
    });
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
