import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  miniAssessmentSourceSchema,
  miniDataOverviewSchema,
  type MiniAudioAsset,
  type MiniAudioProfile,
  type MiniAudioTarget,
} from '@lingoweave/contracts';
import { buildApp } from './app.js';
import { miniDataOverview } from './mini-data-overview.js';
import { MiniStore } from './mini-store.js';
import { MiniAiStore } from './mini-ai-store.js';
import { MiniAudioStore } from './mini-audio-store.js';
import { MiniVocabularyStore } from './mini-vocabulary-store.js';
import { MiniAssessmentStore } from './mini-assessment-store.js';

const now = () => new Date('2026-11-01T04:00:00Z');
const timezone = 'Asia/Shanghai';
const token = 'a'.repeat(64);
const word = { spelling: 'bag', meaning: '包', phonetic: '' };

test('data overview authenticates, reports persisted learning and leaves learning and files unchanged', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-data-api-'));
  const dataDirectory = join(directory, 'data');
  const store = new MiniStore(join(dataDirectory, 'mini.sqlite'), { now, timezone });
  const app = buildApp({ mini: { store, token, dataDirectory } });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  store.importLegacy({
    requestId: randomUUID(),
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
  });
  store.command({
    requestId: randomUUID(),
    expectedRevision: store.snapshot().revision,
    action: { type: 'begin', target: 'daily', deck: [word], timezone },
  });
  const day = store.snapshot().ledger.days[0];
  assert.ok(day);
  store.command({
    requestId: randomUUID(),
    expectedRevision: store.snapshot().revision,
    action: {
      type: 'add_sentences',
      target: 'daily',
      dayId: day.id,
      sentences: [{ word, english: 'My bag is blue.', chinese: '我的包是蓝色的。' }],
    },
  });
  store.command({
    requestId: randomUUID(),
    expectedRevision: store.snapshot().revision,
    action: { type: 'mark_studied', target: 'daily', dayId: day.id, word },
  });
  const before = store.snapshot();
  const files = await readdir(dataDirectory);
  const bytes = await Promise.all(files.map((file) => readFile(join(dataDirectory, file))));
  const url = '/api/mini/data-overview';
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${token}`, origin: 'http://127.0.0.1' },
      })
    ).statusCode,
    403,
  );
  const response = await app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  const overview = miniDataOverviewSchema.parse(response.json());
  assert.deepEqual(overview.learning, {
    completedWords: 0,
    reviewVisits: 0,
    studyDays: 1,
    events: 3,
    translations: 0,
  });
  assert.equal(overview.dataPath, dataDirectory);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(await readdir(dataDirectory), files);
  assert.deepEqual(
    await Promise.all(files.map((file) => readFile(join(dataDirectory, file)))),
    bytes,
  );
  assert.ok(!response.body.includes('我的包'));
  assert.ok(!response.body.includes(token));
});

const profile: MiniAudioProfile = {
  modelId: 'isolated-test',
  modelRevision: 'fixed',
  engine: 'mlx-audio',
  engineVersion: 'test',
  generationVersion: 'v1',
  language: 'English',
  temperature: 0.3,
  maxTokens: 64,
};

test('data overview counts complete stores and real files, classifies WAL and sources, and skips symbolic links', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-data-files-'));
  const dataDirectory = join(directory, 'data');
  const store = new MiniStore(join(dataDirectory, 'mini.sqlite'), { now, timezone });
  const ai = new MiniAiStore(join(dataDirectory, 'mini-ai.sqlite'), now);
  const audio = new MiniAudioStore(join(dataDirectory, 'mini-audio.sqlite'), now);
  const vocabulary = new MiniVocabularyStore(join(dataDirectory, 'mini-vocabulary.sqlite'));
  t.after(async () => {
    vocabulary.close();
    audio.close();
    ai.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  ai.importLegacy({
    requestId: randomUUID(),
    conversations: [
      {
        id: 'advisor',
        title: '学习顾问',
        word: null,
        messages: Array.from({ length: 205 }, () => ({
          id: randomUUID(),
          role: 'user' as const,
          text: 'test',
        })),
      },
    ],
  });
  const target: MiniAudioTarget = { kind: 'word', word };
  function generation(target: MiniAudioTarget, key: string) {
    const result = audio.request(
      { requestId: randomUUID(), target, operation: 'regenerate' },
      key,
      { profile, instructions: '', text: 'bag', normalizedText: 'bag', target },
      null,
    ).result;
    assert.ok(result.job);
    return result.job;
  }
  function asset(target: MiniAudioTarget, key: string): MiniAudioAsset {
    const id = randomUUID();
    return {
      id,
      targetKey: key,
      target,
      text: 'bag',
      normalizedText: 'bag',
      language: 'English',
      voice: 'ryan',
      profile,
      instructions: '',
      fileName: id + '.wav',
      sha256: 'a'.repeat(64),
      bytes: 4,
      sampleRate: 24000,
      channels: 1,
      durationSeconds: 1,
      createdAt: 1,
    };
  }
  const old = asset(target, 'word');
  audio.complete(generation(target, 'word').id, old);
  const current = asset(target, 'word');
  audio.complete(generation(target, 'word').id, current);
  const sentenceTarget: MiniAudioTarget = {
    kind: 'sentence',
    sentence: {
      word,
      english: 'My bag is blue.',
      chinese: '我的包是蓝色的。',
    },
  };
  const sentence = asset(sentenceTarget, 'sentence');
  audio.complete(generation(sentenceTarget, 'sentence').id, sentence);
  generation(target, 'waiting');
  audio.update(generation(target, 'failure').id, 'interrupted', 'interrupted');
  const sources = [
    {
      id: 'words',
      title: 'Words',
      url: 'https://example.org/words',
      version: '1',
      sha256: 'a'.repeat(64),
      license: 'Test',
      role: 'wordlist' as const,
    },
    {
      id: 'dictionary',
      title: 'Dictionary',
      url: 'https://example.org/dictionary',
      version: '1',
      sha256: 'b'.repeat(64),
      license: 'Test',
      role: 'dictionary' as const,
    },
  ];
  vocabulary.import({
    requestId: randomUUID(),
    expectedRevision: 0,
    id: 'test-book',
    name: 'Test book',
    activate: true,
    sources,
    entries: [{ id: 'bag', word, level: 'A1', partOfSpeech: 'n.', sourceEntry: 'bag n.', rank: 0 }],
  });
  for (const path of ['audio', 'materials/sources', 'vocabulary/sources'])
    await mkdir(join(dataDirectory, path), { recursive: true });
  await writeFile(join(dataDirectory, 'audio', old.fileName), 'old!');
  await writeFile(join(dataDirectory, 'audio', sentence.fileName), 'line');
  await writeFile(join(dataDirectory, 'audio', 'orphan.wav'), 'orphan');
  await writeFile(join(dataDirectory, 'audio', '.worker.tmp.wav'), 'live');
  await writeFile(join(dataDirectory, 'materials/sources', 'source.txt'), 'materials');
  await writeFile(join(dataDirectory, 'vocabulary/sources', 'words.pdf'), 'words');
  const external = join(directory, 'external.wav');
  await writeFile(external, 'external private file');
  await symlink(external, join(dataDirectory, 'audio', current.fileName));
  await symlink(directory, join(dataDirectory, 'linked-directory'));
  await writeFile(join(directory, 'service.log'), 'log');
  const before = {
    study: store.snapshot(),
    ai: ai.snapshot(),
    audio: audio.snapshot(),
    vocabulary: vocabulary.snapshot(),
  };
  const overview = await miniDataOverview({
    store,
    ai,
    audio,
    vocabulary,
    dataDirectory,
    now,
    timezone,
  });
  assert.equal(overview.ai.messages, 205, 'Counts use all messages beyond the UI snapshot limit');
  assert.equal(overview.ai.conversations, 1);
  assert.deepEqual(overview.audio, {
    wordAssets: 2,
    sentenceAssets: 1,
    currentAssets: 2,
    previousAssets: 1,
    missingFiles: 1,
    unreferencedFiles: 1,
    pendingJobs: 1,
    failedJobs: 1,
  });
  assert.deepEqual(overview.vocabulary, { books: 1, entries: 1 });
  const sizes = new Map(overview.storage.map((item) => [item.kind, item.bytes]));
  assert.equal(sizes.get('audioFiles'), 18, 'Temporary worker bytes count, symbolic links do not');
  assert.equal(sizes.get('materials'), 9);
  assert.equal(sizes.get('serviceLog'), 3);
  for (const [kind, name] of [
    ['learning', 'mini.sqlite'],
    ['ai', 'mini-ai.sqlite'],
    ['audioIndex', 'mini-audio.sqlite'],
    ['vocabulary', 'mini-vocabulary.sqlite'],
  ] as const) {
    let expected = kind === 'vocabulary' ? 5 : 0;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        expected += (await stat(join(dataDirectory, name + suffix))).size;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    assert.equal(sizes.get(kind), expected);
  }
  assert.deepEqual(
    {
      study: store.snapshot(),
      ai: ai.snapshot(),
      audio: audio.snapshot(),
      vocabulary: vocabulary.snapshot(),
    },
    before,
  );
  await assert.rejects(miniDataOverview({ store, dataDirectory: join(directory, 'missing'), now }));
  await assert.rejects(
    miniDataOverview({ store, dataDirectory: join(dataDirectory, 'linked-directory'), now }),
  );
});

test('assessment overview includes the waiting learning outbox and reconciles committed receipts without starting tasks', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-data-outbox-'));
  const filename = join(directory, 'mini.sqlite');
  const store = new MiniStore(filename, { now, timezone });
  const assessment = new MiniAssessmentStore(join(directory, 'mini-ai.sqlite'), now);
  const fixture = new DatabaseSync(filename);
  t.after(async () => {
    fixture.close();
    assessment.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  function source() {
    const id = randomUUID();
    return miniAssessmentSourceSchema.parse({
      schemaVersion: 1,
      id,
      attemptId: id,
      dayId: '2026-11-01',
      word,
      timezone,
      question: {
        id: id + '/0',
        direction: 'chineseToEnglish',
        english: 'My bag is blue.',
        chinese: '我的包是蓝色的。',
      },
      answer: 'My bag is blue.',
      submittedAt: 800000000,
      confirmedAt: 800000001,
      learningEvidence: {},
      discussion: [],
    });
  }
  const waiting = source(),
    failed = source(),
    finished = source(),
    committed = source();
  const snapshot = store.snapshot();
  snapshot.assessmentSources = [waiting, failed, finished, committed];
  // Persist the two sides of the recovery boundary independently, as after a crash.
  fixture.prepare('UPDATE mini_state SET body=? WHERE id=1').run(JSON.stringify(snapshot));
  fixture
    .prepare(
      'INSERT INTO mini_assessment_records(source_id,request_id,fingerprint,application,receipt) VALUES(?,?,?,?,?)',
    )
    .run(committed.id, committed.id, 'fixture', '{}', '{}');
  assessment.ensure(failed);
  assessment.status(failed.id, 'failed', 'controlled failure');
  assessment.ensure(finished);
  assessment.status(finished.id, 'completed');
  assessment.ensure(committed);
  const before = assessment.all();
  const report = await miniDataOverview({
    store,
    assessment,
    dataDirectory: directory,
    now,
    timezone,
  });
  assert.equal(
    report.ai.pendingAssessments,
    1,
    'A frozen source with no task is pending, a failed task needs retry',
  );
  assert.equal(report.ai.failedAssessments, 1);
  assert.equal(
    report.ai.completedAssessments,
    2,
    'An authoritative learning receipt wins over an unreconciled queued task',
  );
  assert.deepEqual(assessment.all(), before);
  assert.deepEqual(store.snapshot(), snapshot);
});
