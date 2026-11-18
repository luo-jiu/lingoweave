import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { z } from 'zod';
import {
  miniVocabularyEntrySchema,
  miniVocabularyImportSchema,
  miniVocabularySnapshotSchema,
  miniSnapshotSchema,
  type MiniVocabularyImport,
} from '@lingoweave/contracts';
import { buildApp } from './app.js';
import { MiniStore } from './mini-store.js';
import { MiniVocabularyStore } from './mini-vocabulary-store.js';

function input(): MiniVocabularyImport {
  return {
    requestId: randomUUID(),
    expectedRevision: 0,
    id: 'oxford3000',
    name: '牛津 3000',
    activate: true,
    sources: [
      {
        id: 'oxford',
        title: 'Official word list',
        url: 'https://example.org/wordlist.pdf',
        version: 'fixed',
        sha256: 'a'.repeat(64),
        license: 'Personal study source',
        role: 'wordlist',
      },
      {
        id: 'dictionary',
        title: 'Dictionary',
        url: 'https://example.org/dictionary',
        version: 'fixed',
        sha256: 'b'.repeat(64),
        license: 'MIT',
        role: 'dictionary',
      },
    ],
    entries: [
      {
        id: 'advanced',
        word: { spelling: 'abstract', meaning: '抽象的', phonetic: '' },
        level: 'B2',
        rank: 0,
        partOfSpeech: 'adj.',
        sourceEntry: 'abstract adj.',
      },
      {
        id: 'apple',
        word: { spelling: 'apple', meaning: '苹果', phonetic: 'ˈæpəl' },
        level: 'A1',
        rank: 1,
        partOfSpeech: 'n.',
        sourceEntry: 'apple n.',
      },
      {
        id: 'apple-later',
        word: { spelling: 'apple', meaning: '苹果', phonetic: 'ˈæpəl' },
        level: 'A2',
        rank: 2,
        partOfSpeech: 'n.',
        sourceEntry: 'apple n.',
      },
    ],
  };
}

test('vocabulary import preserves sources, book filters, idempotency and activation across restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingoweave-vocabulary-'));
  const filename = join(directory, 'vocabulary.sqlite');
  let store = new MiniVocabularyStore(filename);
  try {
    const request = input();
    const imported = store.import(request);
    assert.equal(imported.revision, 1);
    assert.deepEqual(
      imported.activeWords.map((word) => word.spelling),
      ['abstract', 'apple'],
    );
    assert.equal(imported.activeOrder, 'random');
    assert.deepEqual(imported.books, [
      {
        id: 'oxford3000',
        name: '牛津 3000',
        wordCount: 2,
        levels: [
          { level: 'A1', deckId: 'oxford3000-a1', wordCount: 1 },
          { level: 'A2', deckId: 'oxford3000-a2', wordCount: 1 },
          { level: 'B2', deckId: 'oxford3000-b2', wordCount: 1 },
        ],
      },
    ]);
    assert.equal(imported.decks.find((deck) => deck.id === 'oxford3000-a1')?.wordCount, 1);
    assert.ok(imported.decks.every((deck) => deck.bookId === 'oxford3000'));
    assert.ok(!imported.decks.some((deck) => deck.level === 'B1'));
    assert.equal(store.wordContext({ spelling: 'APPLE', meaning: '', phonetic: '' }).length, 2);
    const apple = imported.activeWords.find((word) => word.spelling === 'apple');
    assert.ok(apple);
    const context = store.lessonContext([apple]);
    assert.equal(context.activeDeck?.id, 'oxford3000');
    assert.deepEqual(
      context.targets.map((target) => target.level),
      ['A1', 'A2'],
    );
    assert.deepEqual(store.import(request), imported);
    const activation = { requestId: randomUUID(), expectedRevision: 1, deckId: 'oxford3000-b2' };
    const activated = store.activate(activation);
    assert.equal(activated.activeWords[0]?.spelling, 'abstract');
    assert.deepEqual(store.activate(activation), activated);
    assert.throws(() => store.activate({ ...activation, deckId: null }));
    assert.throws(() =>
      store.activate({ requestId: randomUUID(), expectedRevision: 1, deckId: null }),
    );
    const beforeInvalid = store.snapshot();
    const first = request.entries[0];
    assert.ok(first);
    assert.throws(() =>
      store.import({
        ...request,
        requestId: randomUUID(),
        expectedRevision: 2,
        entries: [...request.entries, first],
      }),
    );
    assert.deepEqual(store.snapshot(), beforeInvalid);
    store.close();
    store = new MiniVocabularyStore(filename);
    assert.deepEqual(store.snapshot(), activated);
    assert.equal(store.snapshot().sources[0]?.sha256, 'a'.repeat(64));
    assert.equal(
      store.activate({ requestId: randomUUID(), expectedRevision: 2, deckId: null }).activeWords
        .length,
      0,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('vocabulary HTTP import and activation use the local bearer and leave learning facts intact', async () => {
  const study = new MiniStore(':memory:');
  const vocabulary = new MiniVocabularyStore(':memory:');
  const token = 'v'.repeat(64);
  const app = buildApp({ mini: { store: study, vocabulary, token } });
  try {
    const before = study.snapshot();
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/mini/vocabulary/catalog' })).statusCode,
      401,
    );
    const headers = { authorization: `Bearer ${token}` };
    const request = input();
    request.entries = ['zebra', 'apple', 'book', 'car', 'dog', 'egg'].map((spelling, rank) => ({
      id: spelling,
      word: { spelling, meaning: `释义 ${spelling}`, phonetic: '' },
      level: rank < 3 ? 'A1' : 'B1',
      rank,
      partOfSpeech: 'n.',
      sourceEntry: spelling,
    }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/mini/vocabulary/import',
      headers,
      payload: request,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().activeDeckId, 'oxford3000');
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/mini/vocabulary/catalog',
          headers: { ...headers, origin: 'https://example.org' },
        })
      ).statusCode,
      403,
    );
    assert.deepEqual(study.snapshot(), before);
    const catalog = miniVocabularySnapshotSchema.parse(response.json());
    const sourceResponse = await app.inject({
      method: 'POST',
      url: '/api/mini/vocabulary/activate',
      headers,
      payload: {
        requestId: randomUUID(),
        expectedRevision: catalog.revision,
        deckId: catalog.activeDeckId,
        order: 'source',
      },
    });
    assert.equal(sourceResponse.statusCode, 200);
    const source = miniVocabularySnapshotSchema.parse(sourceResponse.json());
    assert.equal(source.activeOrder, 'source');
    assert.deepEqual(
      source.activeWords,
      request.entries.map((entry) => entry.word),
    );
    assert.deepEqual(source.books, catalog.books);
    assert.deepEqual(study.snapshot(), before);
    study.importLegacy({
      requestId: randomUUID(),
      ledger: { days: [] },
      reviewRecord: null,
      reviewHistory: [],
      timezone: 'Asia/Shanghai',
    });
    const begunResponse = await app.inject({
      method: 'POST',
      url: '/api/mini/commands',
      headers,
      payload: {
        requestId: randomUUID(),
        expectedRevision: study.snapshot().revision,
        action: {
          type: 'begin',
          target: 'daily',
          deck: source.activeWords,
          timezone: 'Asia/Shanghai',
          flowVersion: 'memory-rounds-v1',
        },
      },
    });
    assert.equal(begunResponse.statusCode, 200);
    const begun = miniSnapshotSchema.parse(begunResponse.json());
    assert.deepEqual(begun.ledger.days[0]?.learningWords, source.activeWords.slice(0, 5));
    const filteredResponse = await app.inject({
      method: 'POST',
      url: '/api/mini/vocabulary/activate',
      headers,
      payload: {
        requestId: randomUUID(),
        expectedRevision: source.revision,
        deckId: 'oxford3000-b1',
        order: 'random',
      },
    });
    assert.equal(filteredResponse.statusCode, 200);
    const filtered = miniVocabularySnapshotSchema.parse(filteredResponse.json());
    assert.equal(filtered.activeOrder, 'random');
    assert.deepEqual([...filtered.activeWords.map((word) => word.spelling)].sort(), [
      'car',
      'dog',
      'egg',
    ]);
    assert.deepEqual(study.snapshot(), begun);
  } finally {
    await app.close();
  }
});

test('vocabulary shuffles the selected book or level while retaining source order and sense selection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingoweave-vocabulary-shuffle-'));
  const filename = join(directory, 'vocabulary.sqlite');
  let store = new MiniVocabularyStore(filename);
  try {
    const request = input();
    const groups: Array<{
      level: NonNullable<MiniVocabularyImport['entries'][number]['level']>;
      spellings: string[];
    }> = [
      { level: 'A1', spellings: ['apple', 'banana', 'car', 'dog', 'egg', 'fish'] },
      { level: 'A2', spellings: ['garden', 'holiday', 'journey'] },
      { level: 'B1', spellings: ['achievement', 'benefit'] },
      { level: 'B2', spellings: ['abstract', 'capacity'] },
    ];
    request.entries = groups.flatMap(({ level, spellings }, groupIndex) =>
      spellings.map((spelling, index) => ({
        id: spelling,
        word: { spelling, meaning: `释义 ${spelling}`, phonetic: 'original' },
        level,
        rank: groupIndex * 100 + index,
        partOfSpeech: 'n.',
        sourceEntry: `${spelling} n.`,
      })),
    );
    const apple = request.entries[0];
    assert.ok(apple);
    request.entries.push({
      ...apple,
      id: 'apple-duplicate',
      rank: 1000,
      word: { ...apple.word, phonetic: 'later' },
      sourceEntry: 'apple n. repeated',
    });
    const originalEntries = structuredClone(request.entries);
    const imported = store.import(request);
    const allWords = imported.activeWords;
    assert.equal(allWords.length, 13);
    assert.deepEqual(request.entries, originalEntries);
    assert.equal(allWords.find((word) => word.spelling === 'apple')?.phonetic, 'original');
    assert.deepEqual(store.snapshot(), imported);
    assert.deepEqual(
      store.wordContext(apple.word).map((entry) => entry.sourceEntry),
      ['apple n.', 'apple n. repeated'],
    );

    for (const { level, spellings } of groups) {
      const selected = store.activate({
        requestId: randomUUID(),
        expectedRevision: store.snapshot().revision,
        deckId: `oxford3000-${level.toLowerCase()}`,
      }).activeWords;
      assert.deepEqual(
        selected,
        allWords.filter((word) => spellings.includes(word.spelling)),
      );
      assert.deepEqual([...selected.map((word) => word.spelling)].sort(), [...spellings].sort());
      if (level === 'A1') {
        assert.notDeepEqual(
          selected.map((word) => word.spelling),
          spellings,
        );
      }
    }
    assert.notDeepEqual(
      allWords.map((word) => groups.findIndex((group) => group.spellings.includes(word.spelling))),
      [0, 0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 3, 3],
    );
    store.activate({
      requestId: randomUUID(),
      expectedRevision: store.snapshot().revision,
      deckId: 'oxford3000',
    });
    store.close();
    store = new MiniVocabularyStore(filename);
    assert.deepEqual(store.snapshot().activeWords, allWords);
    const reimported = store.import({
      ...request,
      requestId: randomUUID(),
      expectedRevision: store.snapshot().revision,
    });
    assert.deepEqual(reimported.activeWords, allWords);

    const saved = new DatabaseSync(filename, { readOnly: true });
    try {
      const row = saved.prepare('SELECT body FROM vocabulary_state WHERE id=1').get();
      assert.ok(row && typeof row.body === 'string');
      const state = z
        .object({ collections: z.array(z.object({ entries: z.array(miniVocabularyEntrySchema) })) })
        .parse(JSON.parse(row.body));
      assert.deepEqual(state.collections[0]?.entries, originalEntries);
    } finally {
      saved.close();
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('source order is saved independently from the selected level and survives legacy activation replay', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingoweave-vocabulary-order-'));
  const filename = join(directory, 'vocabulary.sqlite');
  let store = new MiniVocabularyStore(filename);
  try {
    const request = input();
    request.entries = ['zebra', 'apple', 'book', 'car', 'dog', 'egg'].map((spelling, rank) => ({
      id: spelling,
      word: { spelling, meaning: `释义 ${spelling}`, phonetic: '' },
      level: rank < 3 ? 'A1' : 'A2',
      rank,
      partOfSpeech: 'n.',
      sourceEntry: spelling,
    }));
    const randomized = store.import(request);
    const sourceRequest = {
      requestId: randomUUID(),
      expectedRevision: randomized.revision,
      deckId: 'oxford3000',
      order: 'source' as const,
    };
    const source = store.activate(sourceRequest);
    assert.equal(source.activeOrder, 'source');
    assert.deepEqual(
      source.activeWords.map((word) => word.spelling),
      request.entries.map((entry) => entry.word.spelling),
    );
    assert.notDeepEqual(source.activeWords, randomized.activeWords);
    assert.deepEqual(source.books, randomized.books);
    assert.deepEqual(store.activate(sourceRequest), source);
    assert.throws(() => store.activate({ ...sourceRequest, order: 'random' }));
    const legacyRequest = {
      requestId: randomUUID(),
      expectedRevision: source.revision,
      deckId: 'oxford3000-a1',
    };
    const filtered = store.activate(legacyRequest);
    assert.equal(filtered.activeOrder, 'source');
    assert.deepEqual(
      filtered.activeWords.map((word) => word.spelling),
      ['zebra', 'apple', 'book'],
    );
    const noChange = store.activate({
      ...legacyRequest,
      requestId: randomUUID(),
      expectedRevision: filtered.revision,
    });
    assert.equal(noChange.revision, filtered.revision);
    store.close();
    store = new MiniVocabularyStore(filename);
    assert.deepEqual(store.snapshot(), filtered);
    assert.deepEqual(store.activate(legacyRequest), filtered);
    const random = store.activate({
      requestId: randomUUID(),
      expectedRevision: filtered.revision,
      deckId: 'oxford3000-a1',
      order: 'random',
    });
    assert.equal(random.activeOrder, 'random');
    assert.equal(random.revision, filtered.revision + 1);
    assert.deepEqual(
      random.activeWords,
      randomized.activeWords.filter((word) => ['zebra', 'apple', 'book'].includes(word.spelling)),
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ungraded books have one full selection and can use either stable shuffle or source order', () => {
  const store = new MiniVocabularyStore(':memory:');
  try {
    const base = input();
    const request = miniVocabularyImportSchema.parse({
      ...base,
      id: 'travel',
      name: '旅行英语',
      entries: ['welcome', 'ticket', 'airport', 'hotel', 'taxi'].map((spelling, rank) => ({
        id: spelling,
        word: { spelling, meaning: `释义 ${spelling}`, phonetic: '' },
        rank,
        partOfSpeech: '',
        sourceEntry: spelling,
      })),
    });
    assert.ok(request.entries.every((entry) => entry.level === null));
    const snapshot = store.import(request);
    assert.equal(snapshot.decks.length, 1);
    assert.deepEqual(snapshot.books, [
      { id: 'travel', name: '旅行英语', wordCount: 5, levels: [] },
    ]);
    assert.deepEqual(store.snapshot().activeWords, snapshot.activeWords);
    const source = store.activate({
      requestId: randomUUID(),
      expectedRevision: snapshot.revision,
      deckId: 'travel',
      order: 'source',
    });
    assert.deepEqual(
      source.activeWords,
      request.entries.map((entry) => entry.word),
    );
    assert.notDeepEqual(source.activeWords, snapshot.activeWords);
    assert.throws(() =>
      store.activate({
        requestId: randomUUID(),
        expectedRevision: source.revision,
        deckId: 'travel-a1',
      }),
    );
    assert.deepEqual(store.snapshot(), source);
  } finally {
    store.close();
  }
});

test('legacy persisted vocabulary loads a default order without changing its revision or old receipts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingoweave-vocabulary-legacy-'));
  const filename = join(directory, 'vocabulary.sqlite');
  let store = new MiniVocabularyStore(filename);
  try {
    const request = input();
    store.import(request);
    const activation = { requestId: randomUUID(), expectedRevision: 1, deckId: 'oxford3000-a1' };
    const selected = store.activate(activation);
    store.close();
    const old = new DatabaseSync(filename);
    try {
      const row = old.prepare('SELECT body FROM vocabulary_state WHERE id=1').get();
      assert.ok(row && typeof row.body === 'string');
      const state = z.record(z.string(), z.unknown()).parse(JSON.parse(row.body));
      delete state.activeOrder;
      old.prepare('UPDATE vocabulary_state SET body=? WHERE id=1').run(JSON.stringify(state));
    } finally {
      old.close();
    }
    store = new MiniVocabularyStore(filename);
    assert.deepEqual(store.snapshot(), selected);
    assert.deepEqual(store.activate(activation), selected);
    assert.equal(store.snapshot().revision, 2);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a legacy empty level selection migrates to its full book once during startup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingoweave-vocabulary-empty-level-'));
  const filename = join(directory, 'vocabulary.sqlite');
  let store = new MiniVocabularyStore(filename);
  try {
    store.import(input());
    store.close();
    const old = new DatabaseSync(filename);
    try {
      const row = old.prepare('SELECT body FROM vocabulary_state WHERE id=1').get();
      assert.ok(row && typeof row.body === 'string');
      const state = z.record(z.string(), z.unknown()).parse(JSON.parse(row.body));
      state.activeDeckId = 'oxford3000-b1';
      delete state.activeOrder;
      old.prepare('UPDATE vocabulary_state SET body=? WHERE id=1').run(JSON.stringify(state));
    } finally {
      old.close();
    }
    store = new MiniVocabularyStore(filename);
    const migrated = store.snapshot();
    assert.equal(migrated.activeDeckId, 'oxford3000');
    assert.equal(migrated.activeOrder, 'random');
    assert.equal(migrated.revision, 2);
    assert.equal(migrated.activeWords.length, 2);
    store.close();
    store = new MiniVocabularyStore(filename);
    assert.deepEqual(store.snapshot(), migrated);
    const additional = store.import({
      ...input(),
      id: 'oxford3000-b1',
      name: '另一套词书',
      requestId: randomUUID(),
      expectedRevision: migrated.revision,
    });
    store.close();
    store = new MiniVocabularyStore(filename);
    assert.deepEqual(store.snapshot(), additional);
    assert.equal(store.snapshot().activeDeckId, 'oxford3000-b1');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('book identity collisions roll back the import and removed active levels return to the full book', () => {
  const store = new MiniVocabularyStore(':memory:');
  try {
    const request = input();
    const imported = store.import(request);
    assert.throws(() =>
      store.import({
        ...request,
        requestId: randomUUID(),
        expectedRevision: imported.revision,
        id: 'oxford3000-a1',
        activate: false,
      }),
    );
    assert.deepEqual(store.snapshot(), imported);
    const selected = store.activate({
      requestId: randomUUID(),
      expectedRevision: imported.revision,
      deckId: 'oxford3000-a1',
      order: 'source',
    });
    const updated = store.import({
      ...request,
      requestId: randomUUID(),
      expectedRevision: selected.revision,
      activate: false,
      entries: request.entries.filter((entry) => entry.level === 'B2'),
    });
    assert.equal(updated.activeDeckId, 'oxford3000');
    assert.equal(updated.activeOrder, 'source');
    assert.equal(updated.books[0]?.levels.length, 1);
    assert.equal(updated.activeWords.length, 1);
  } finally {
    store.close();
  }
});
