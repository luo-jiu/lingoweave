import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  access,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { MiniVocabularyStore } from '../apps/server/dist/mini-vocabulary-store.js';
import { resetStudyData, validateResetPaths } from './mini-reset.mjs';

const release = 'com.lingoweave.mini';
const dev = 'com.lingoweave.mini.dev';

async function fixture(t, bundle = release) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'lingoweave-reset-test-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const library = join(temporary, 'Library');
  const profile = join(library, 'Application Support', bundle);
  const data = join(profile, 'service', 'data');
  await mkdir(data, { recursive: true });
  let preferencesResets = 0;
  const reset = (overrides = {}) =>
    resetStudyData({
      library,
      bundle,
      assertStopped: async () => {},
      resetPreferences: async () => {
        preferencesResets++;
      },
      ...overrides,
    });
  return { library, profile, data, temporary, reset, preferencesResets: () => preferencesResets };
}

async function stamp(path, text = 'test evidence') {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const missing = (path) => assert.rejects(access(path), { code: 'ENOENT' });

function seedVocabulary(filename) {
  const store = new MiniVocabularyStore(filename);
  try {
    const sources = ['wordlist', 'dictionary'].map((role) => ({
      id: role,
      role,
      title: role,
      url: 'https://example.org/' + role,
      sha256: 'a'.repeat(64),
      license: 'Test fixture',
      version: '1',
    }));
    for (const [rank, spelling] of ['bag', 'book'].entries()) {
      store.import({
        id: 'book-' + spelling,
        name: 'Fixture ' + spelling,
        requestId: randomUUID(),
        expectedRevision: store.snapshot().revision,
        activate: true,
        sources,
        entries: [
          {
            id: spelling,
            word: { spelling, meaning: spelling, phonetic: '' },
            rank,
            level: 'A1',
            sourceEntry: spelling,
            partOfSpeech: 'n.',
          },
        ],
      });
    }
    store.activate({
      requestId: randomUUID(),
      expectedRevision: store.snapshot().revision,
      deckId: 'book-book-a1',
      order: 'source',
    });
    return store.snapshot();
  } finally {
    store.close();
  }
}

for (const bundle of [release, dev]) {
  test('resets only ' + bundle + ' and keeps imported books and their sources', async (t) => {
    const f = await fixture(t, bundle);
    const vocabulary = join(f.data, 'mini-vocabulary.sqlite');
    const books = seedVocabulary(vocabulary);
    const preserved = [
      join(f.data, 'materials/sources/test-book.txt'),
      join(f.data, 'materials/catalog.json'),
      join(f.data, 'vocabulary/sources/test-license.txt'),
      join(f.data, 'my-manual-import.txt'),
      join(f.profile, 'unrecognized-user-file.txt'),
      join(f.profile, 'service/process.json'),
      join(f.profile, 'service/start.lock/owner'),
      join(
        f.library,
        'Application Support',
        bundle === release ? dev : release,
        'service/data/mini.sqlite',
      ),
      join(f.temporary, 'sdks/test-model.bin'),
    ];
    const erased = [
      join(f.profile, 'service/service.log'),
      join(f.library, 'Caches', bundle, 'cache.db'),
      join(f.library, 'HTTPStorages', bundle, 'http.sqlite'),
      join(f.library, 'HTTPStorages', bundle + '.binarycookies'),
      join(f.library, 'Saved Application State', bundle + '.savedState', 'state.data'),
      ...[
        'mini.sqlite',
        'mini.sqlite-wal',
        'mini.sqlite-shm',
        'mini-ai.sqlite',
        'mini-audio.sqlite',
        'lingoweave.sqlite',
        'audio/example.wav',
        'agent-workspace/private.txt',
        'mini-agent-workspace/private.txt',
        'mini-assessment-workspace/private.txt',
      ].map((name) => join(f.data, name)),
      ...[
        'DailyStudy/ledger.json',
        'Review/History/old.json',
        'StudyChat.json',
        'migration-backup/chat-import-request.json',
        'service-client/pending-command.json',
        'service-client/chat-drafts.json',
      ].map((name) => join(f.profile, name)),
    ];
    for (const p of [...preserved, ...erased]) await stamp(p);
    const external = preserved.at(-1);
    await symlink(external, join(f.data, 'audio/linked.wav'));
    await f.reset();
    assert.equal(f.preferencesResets(), 1);
    for (const p of preserved) assert.equal(await readFile(p, 'utf8'), 'test evidence', p);
    for (const p of erased) await missing(p);
    const reopened = new MiniVocabularyStore(vocabulary);
    try {
      const snapshot = reopened.snapshot();
      assert.deepEqual(snapshot.books, books.books);
      assert.deepEqual(snapshot.sources, books.sources);
      assert.equal(snapshot.activeDeckId, null);
      assert.equal(snapshot.activeOrder, 'random');
      const active = reopened.activate({
        requestId: randomUUID(),
        expectedRevision: snapshot.revision,
        deckId: 'book-book-a1',
      });
      assert.deepEqual(
        active.activeWords.map((word) => word.spelling),
        ['book'],
      );
    } finally {
      reopened.close();
    }
    await f.reset();
    const db = new DatabaseSync(vocabulary, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vocabulary_requests').get().n, 0);
    } finally {
      db.close();
    }
  });
}

test('preserves a committed vocabulary change present only in its WAL', async (t) => {
  const f = await fixture(t);
  const filename = join(f.temporary, 'stopped-writer.sqlite');
  const vocabulary = join(f.data, 'mini-vocabulary.sqlite');
  seedVocabulary(filename);
  const writer = new DatabaseSync(filename);
  try {
    // Capture one stable database/WAL pair before the last connection checkpoints.
    writer.exec('PRAGMA wal_autocheckpoint=0');
    writer
      .prepare("UPDATE vocabulary_state SET body=json_set(body,'$.collections[0].name',?)")
      .run('Last import');
    await copyFile(filename, vocabulary);
    await copyFile(filename + '-wal', vocabulary + '-wal');
  } finally {
    writer.close();
  }
  await f.reset();
  const reopened = new MiniVocabularyStore(vocabulary);
  try {
    assert.equal(reopened.snapshot().books[0].name, 'Last import');
  } finally {
    reopened.close();
  }
});

test('refuses active profile and invalid profile names before touching data or preferences', async (t) => {
  const f = await fixture(t);
  const chat = join(f.data, 'mini-ai.sqlite');
  await stamp(chat);
  await assert.rejects(
    f.reset({
      assertStopped: async () => {
        throw new Error('profile still active');
      },
    }),
    /profile still active/,
  );
  await assert.rejects(f.reset({ bundle: '../com.lingoweave.mini' }));
  assert.equal(await readFile(chat, 'utf8'), 'test evidence');
  assert.equal(f.preferencesResets(), 0);
});

test('unrecognized vocabulary storage stops reset before any learning history is lost', async (t) => {
  const f = await fixture(t);
  const vocabulary = join(f.data, 'mini-vocabulary.sqlite');
  seedVocabulary(vocabulary);
  const db = new DatabaseSync(vocabulary);
  try {
    db.exec('PRAGMA user_version=2');
  } finally {
    db.close();
  }
  const history = join(f.profile, 'service-client/pending-command.json');
  await stamp(history);
  await assert.rejects(f.reset());
  assert.equal(await readFile(history, 'utf8'), 'test evidence');
  assert.equal(f.preferencesResets(), 0);
});

test('does not traverse a linked service/data directory', async (t) => {
  const f = await fixture(t);
  const exterior = join(f.temporary, 'external');
  const sentinel = join(exterior, 'mini.sqlite');
  await stamp(sentinel);
  await rm(f.data, { recursive: true });
  await symlink(exterior, f.data);
  await assert.rejects(validateResetPaths(f.library, release));
  await assert.rejects(f.reset());
  assert.equal(await readFile(sentinel, 'utf8'), 'test evidence');
  assert.equal(f.preferencesResets(), 0);
});

for (const [name, makeLink] of [
  ['mini-vocabulary.sqlite', link],
  ['mini-vocabulary.sqlite-wal', symlink],
]) {
  test('rejects linked vocabulary file ' + name + ' before cleanup', async (t) => {
    const f = await fixture(t);
    const external = join(f.temporary, 'external-book.sqlite');
    seedVocabulary(external);
    if (name !== 'mini-vocabulary.sqlite') seedVocabulary(join(f.data, 'mini-vocabulary.sqlite'));
    const bytes = await readFile(external);
    const chat = join(f.data, 'mini-ai.sqlite');
    await stamp(chat);
    await makeLink(external, join(f.data, name));
    await assert.rejects(f.reset());
    assert.deepEqual(await readFile(external), bytes);
    assert.equal(await readFile(chat, 'utf8'), 'test evidence');
    assert.equal(f.preferencesResets(), 0);
  });
}
