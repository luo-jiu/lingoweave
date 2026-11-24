import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type {
  MiniAudioProfile,
  MiniAudioRequest,
  MiniAudioTarget,
  MiniAudioRuntime,
} from '@lingoweave/contracts';
import { LearningError } from './learning-store.js';
import { MiniStore } from './mini-store.js';
import { MiniAudioStore } from './mini-audio-store.js';
import { MiniAudioService, inspectMiniWav } from './mini-audio-service.js';
import { LocalMiniTtsRuntime, type MiniTtsRuntime } from './mini-audio-runtime.js';

const timezone = 'Asia/Shanghai';
const now = () => new Date('2026-11-16T04:00:00Z');
const word = { spelling: 'apple', meaning: '苹果', phonetic: '/ˈæpəl/' };
const target: MiniAudioTarget = { kind: 'word', word };
const profile: MiniAudioProfile = {
  modelId: 'test-tts',
  modelRevision: 'fixed-revision',
  engine: 'mlx-audio',
  engineVersion: 'test',
  generationVersion: 'v1',
  language: 'English',
  temperature: 0.7,
  maxTokens: 2048,
};
function wave(seconds = 0.2) {
  const frames = Math.round(24000 * seconds),
    data = Buffer.alloc(44 + frames * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(24000, 24);
  data.writeUInt32LE(48000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(frames * 2, 40);
  for (let index = 0; index < frames; index++)
    data.writeInt16LE(
      Math.round(2000 * Math.sin((index * 2 * Math.PI * 220) / 24000)),
      44 + index * 2,
    );
  return data;
}
type Generation = Parameters<MiniTtsRuntime['generate']>[0];
class FakeRuntime implements MiniTtsRuntime {
  calls: Generation[] = [];
  profile = profile;
  available = true;
  behavior: ((input: Generation) => Promise<void>) | null = null;
  async status(): Promise<MiniAudioRuntime> {
    return {
      available: this.available,
      profile: this.available ? this.profile : null,
      error: this.available ? null : 'Unavailable',
    };
  }
  async generate(input: Generation) {
    this.calls.push(input);
    if (this.behavior) await this.behavior(input);
    else await writeFile(input.outputFile, wave());
  }
  async close() {}
}
function request(fields: Partial<MiniAudioRequest> = {}): MiniAudioRequest {
  return { requestId: randomUUID(), target, operation: 'ensure', ...fields };
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-audio-'));
  const filename = join(directory, 'audio.sqlite');
  const study = new MiniStore(join(directory, 'study.sqlite'), { now, timezone });
  study.importLegacy({
    requestId: randomUUID(),
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
    timezone,
  });
  const store = new MiniAudioStore(filename, now),
    runtime = new FakeRuntime(),
    service = new MiniAudioService(study, store, runtime, {
      directory: join(directory, 'audio'),
      now,
      random: () => 0,
    });
  t.after(async () => {
    await service.close();
    study.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, filename, study, store, runtime, service };
}
async function settled(service: MiniAudioService, id: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const job = service.job(id);
    if (!['queued', 'running'].includes(job.status)) {
      await setImmediate();
      return service.job(id);
    }
    await setImmediate();
  }
  assert.fail('Audio job did not settle');
}

test('audio requests share one persistent job, keep the chosen voice and reuse immutable cached bytes', async (t) => {
  const { service, store, runtime } = await fixture(t);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime.behavior = async (input) => {
    await held;
    await writeFile(input.outputFile, wave());
  };
  const input = request(),
    first = await service.request(input);
  assert.ok(first.job);
  const repeated = await service.request(input),
    shared = await service.request(request());
  assert.equal(repeated.job?.id, first.job.id);
  assert.equal(shared.job?.id, first.job.id);
  assert.equal(shared.reused, true);
  release();
  assert.equal((await settled(service, first.job.id)).status, 'completed');
  assert.equal(runtime.calls.length, 1);
  const ready = await service.request(input);
  assert.ok(ready.asset);
  assert.equal(ready.asset.voice, 'ryan');
  assert.equal(ready.asset.language, 'English');
  assert.equal(ready.asset.fileName, `${ready.asset.id}.wav`);
  const cached = await service.request(request());
  assert.equal(cached.job, null);
  assert.equal(cached.asset?.id, ready.asset.id);
  assert.deepEqual((await service.file(ready.asset.id)).data, wave());
  assert.equal(store.assets().length, 1);
  await assert.rejects(
    service.request({ ...input, operation: 'regenerate' }),
    (error) => error instanceof LearningError && error.code === 'REQUEST_CONFLICT',
  );
});

test('word synthesis sends the exact spelling with its recorded short-word parameters', async (t) => {
  const { service, runtime } = await fixture(t);
  const result = await service.request(request());
  assert.ok(result.job);
  assert.equal((await settled(service, result.job.id)).status, 'completed');
  const call = runtime.calls[0];
  assert.ok(call);
  assert.equal(call.text, 'apple');
  assert.equal(call.instructions, '');
  assert.deepEqual(call.parameters, {
    kind: 'word',
    temperature: 0.3,
    maxTokens: 64,
    maximumDurationSeconds: 2.5,
  });
  const cached = await service.lookup(target);
  assert.equal(cached.asset?.profile.temperature, 0.3);
  assert.equal(cached.asset?.profile.maxTokens, 64);
  assert.equal(cached.asset?.profile.generationVersion, 'v1/word-2');
});

test('rejected word audio retries on the remaining voices and only publishes the accepted attempt', async (t) => {
  const { service, runtime, store } = await fixture(t);
  runtime.behavior = (input) => writeFile(input.outputFile, wave(12.4));
  const input = request();
  const result = await service.request(input);
  assert.ok(result.job);
  const failed = await settled(service, result.job.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /单词音频/);
  assert.equal(store.assets().length, 0);
  assert.equal((await service.lookup(target)).asset, null);
  assert.equal((await service.request(input)).job?.id, failed.id);
  assert.equal(runtime.calls.length, 1);
  const second = await service.request(request());
  assert.ok(second.job && second.job.id !== failed.id);
  assert.equal((await settled(service, second.job.id)).status, 'failed');
  runtime.behavior = null;
  const retry = await service.request(request());
  assert.ok(retry.job);
  assert.equal((await settled(service, retry.job.id)).status, 'completed');
  assert.deepEqual(
    runtime.calls.map((call) => call.voice),
    ['ryan', 'aiden', 'serena'],
  );
  assert.equal((await service.request(request())).asset?.id, retry.job.id);
  assert.equal((await service.request(input)).job?.status, 'failed');
  assert.equal(store.assets().length, 1);
});

test('usable legacy words and sentence caches survive while overlong legacy words are blocked and replaced', async (t) => {
  const { service, runtime, store, directory } = await fixture(t);
  const clean: MiniAudioTarget = {
    kind: 'word',
    word: { spelling: 'clean', meaning: '干净', phonetic: '' },
  };
  const sentence: MiniAudioTarget = {
    kind: 'sentence',
    sentence: { word, english: 'I eat an apple.', chinese: '我吃一个苹果。' },
  };
  await mkdir(join(directory, 'audio'), { recursive: true });
  async function legacy(target: MiniAudioTarget, seconds: number) {
    const word = target.kind === 'word' ? target.word : target.sentence.word;
    const text = target.kind === 'word' ? word.spelling : target.sentence.english;
    const instructions =
      target.kind === 'word'
        ? `Read only the English word naturally and clearly. Intended meaning: ${word.meaning}.${word.phonetic ? ` Pronunciation hint: ${word.phonetic}.` : ''} Do not read the meaning, hint, or instructions aloud.`
        : 'Read the English sentence naturally and clearly. Do not translate or add commentary.';
    const identity = {
      kind: target.kind,
      word,
      ...(target.kind === 'sentence' ? { english: target.sentence.english } : {}),
    };
    const targetKey = createHash('sha256')
      .update(JSON.stringify({ target: identity, normalizedText: text, profile, instructions }))
      .digest('hex');
    const saved = store.request(
      request({ target }),
      targetKey,
      { target, profile, text, normalizedText: text, instructions },
      null,
      () => 0,
    );
    assert.ok(saved.result.job);
    const id = saved.result.job.id,
      data = wave(seconds);
    await writeFile(join(directory, 'audio', `${id}.wav`), data);
    store.complete(id, {
      id,
      targetKey,
      target,
      text,
      normalizedText: text,
      language: 'English',
      voice: 'ryan',
      profile,
      instructions,
      fileName: `${id}.wav`,
      createdAt: 0,
      ...inspectMiniWav(data),
    });
    return id;
  }
  const validId = await legacy(target, 0.8);
  const invalidId = await legacy(clean, 12.4);
  const sentenceId = await legacy(sentence, 12.4);
  assert.equal((await service.lookup(target)).asset?.id, validId);
  assert.equal((await service.request(request())).asset?.id, validId);
  assert.equal((await service.lookup(sentence)).asset?.id, sentenceId);
  assert.equal(runtime.calls.length, 0);
  assert.equal((await service.lookup(clean)).asset, null);
  runtime.available = false;
  assert.equal((await service.request(request())).asset?.id, validId);
  assert.equal((await service.lookup(clean)).asset, null);
  runtime.available = true;
  assert.throws(
    () =>
      service.authorize({
        requestId: randomUUID(),
        assetId: invalidId,
        visitId: randomUUID(),
        mode: 'manual',
      }),
    { code: 'AUDIO_WORD_TOO_LONG' },
  );
  await assert.rejects(service.file(invalidId));
  const replacement = await service.request(request({ target: clean }));
  assert.ok(replacement.job);
  assert.equal((await settled(service, replacement.job.id)).status, 'completed');
  assert.notEqual((await service.lookup(clean)).asset?.id, invalidId);
  assert.equal((await service.lookup(target)).asset?.id, validId);
  assert.equal((await service.lookup(sentence)).asset?.id, sentenceId);
  const regenerated = await service.request(request({ operation: 'regenerate' }));
  assert.ok(regenerated.job);
  assert.equal((await settled(service, regenerated.job.id)).status, 'completed');
  const newerWord = (await service.lookup(target)).asset;
  assert.ok(newerWord);
  assert.notEqual(newerWord.id, validId);
  await rm(join(directory, 'audio', newerWord.fileName));
  runtime.available = false;
  assert.equal((await service.lookup(target)).asset?.id, validId);
  assert.equal((await service.request(request())).asset?.id, validId);
  runtime.available = true;
});

test('regeneration retains the old current asset until a valid replacement is committed', async (t) => {
  const { service, store, runtime } = await fixture(t);
  const first = await service.request(request());
  assert.ok(first.job);
  await settled(service, first.job.id);
  const original = await service.lookup(target);
  assert.ok(original.asset);
  runtime.behavior = async () => {
    throw new Error('offline');
  };
  const failed = await service.request(request({ operation: 'regenerate', voice: 'aiden' }));
  assert.ok(failed.job);
  assert.equal(failed.asset?.id, original.asset.id);
  assert.equal((await settled(service, failed.job.id)).status, 'failed');
  assert.equal((await service.lookup(target)).asset?.id, original.asset.id);
  assert.equal((await service.file(original.asset.id)).asset.voice, 'ryan');
  runtime.behavior = null;
  const replacement = await service.request(request({ operation: 'regenerate', voice: 'aiden' }));
  assert.ok(replacement.job);
  await settled(service, replacement.job.id);
  const current = await service.lookup(target);
  assert.ok(current.asset);
  assert.notEqual(current.asset.id, original.asset.id);
  assert.equal(current.asset.voice, 'aiden');
  assert.equal(store.assets().length, 2);
  assert.deepEqual((await service.file(original.asset.id)).data, wave());
});

test('sense, pronunciation, material and engine profile all participate in cache identity', async (t) => {
  const { service, runtime } = await fixture(t);
  const requests = [
    request(),
    request({ target: { kind: 'word', word: { ...word, meaning: '苹果公司' } } }),
    request({ target: { kind: 'word', word: { ...word, phonetic: '/other/' } } }),
    request({
      target: {
        kind: 'sentence',
        sentence: { word, english: 'I eat an apple.', chinese: '我吃一个苹果。' },
      },
    }),
  ];
  const keys = new Set<string>();
  for (const input of requests) {
    const result = await service.request(input);
    assert.ok(result.job);
    keys.add(result.targetKey);
    await settled(service, result.job.id);
  }
  assert.equal(keys.size, 4);
  runtime.profile = { ...profile, engineVersion: 'new-version' };
  const upgraded = await service.request(request());
  assert.ok(upgraded.job);
  assert.ok(!keys.has(upgraded.targetKey));
  await settled(service, upgraded.job.id);
  assert.equal(runtime.calls.length, 5);
});

test('only one audio generation runs at a time and cancelled AI guards cannot enqueue late jobs', async (t) => {
  const { service, runtime, store } = await fixture(t);
  let active = 0,
    peak = 0;
  runtime.behavior = async (input) => {
    active++;
    peak = Math.max(peak, active);
    await setImmediate();
    await writeFile(input.outputFile, wave());
    active--;
  };
  const first = await service.request(request()),
    second = await service.request(
      request({
        target: { kind: 'word', word: { spelling: 'book', meaning: '书', phonetic: '' } },
      }),
    );
  assert.ok(first.job && second.job);
  await settled(service, first.job.id);
  await settled(service, second.job.id);
  assert.equal(peak, 1);
  const count = store.jobs().length;
  await assert.rejects(
    service.request(request({ operation: 'regenerate' }), () => {
      throw new LearningError('AI_TASK_EXPIRED', 'Stopped', 403);
    }),
    (error) => error instanceof LearningError && error.code === 'AI_TASK_EXPIRED',
  );
  assert.equal(store.jobs().length, count);
});

test('invalid and corrupted WAVs never replace a current asset and ensure repairs a missing cache', async (t) => {
  const { service, runtime, directory } = await fixture(t);
  const first = await service.request(request());
  assert.ok(first.job);
  await settled(service, first.job.id);
  const original = (await service.lookup(target)).asset;
  assert.ok(original);
  runtime.behavior = async (input) => {
    await writeFile(input.outputFile, 'not a wave');
  };
  const failed = await service.request(request({ operation: 'regenerate' }));
  assert.ok(failed.job);
  assert.equal((await settled(service, failed.job.id)).status, 'failed');
  assert.equal((await service.lookup(target)).asset?.id, original.id);
  await writeFile(join(directory, 'audio', original.fileName), Buffer.alloc(original.bytes));
  await assert.rejects(
    service.file(original.id),
    (error) => error instanceof LearningError && error.code === 'AUDIO_ASSET_INVALID',
  );
  assert.equal((await service.lookup(target)).asset, null);
  runtime.behavior = null;
  const repair = await service.request(request());
  assert.ok(repair.job);
  await settled(service, repair.job.id);
  assert.notEqual((await service.lookup(target)).asset?.id, original.id);
});

test('audio snapshots survive reopening; unfinished jobs recover without automatically invoking TTS', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-audio-reopen-'));
  const study = new MiniStore(':memory:', { now, timezone });
  study.importLegacy({
    requestId: randomUUID(),
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
    timezone,
  });
  const filename = join(directory, 'audio.sqlite');
  let store = new MiniAudioStore(filename, now),
    runtime = new FakeRuntime(),
    service = new MiniAudioService(study, store, runtime, {
      directory: join(directory, 'audio'),
      now,
    });
  t.after(async () => {
    await service.close();
    study.close();
    await rm(directory, { recursive: true, force: true });
  });
  const generated = await service.request(request());
  assert.ok(generated.job);
  await settled(service, generated.job.id);
  const snapshot = service.snapshot();
  await service.close();
  store = new MiniAudioStore(filename, now);
  assert.deepEqual(store.snapshot(), snapshot);
  const input = request({
    target: { kind: 'word', word: { spelling: 'book', meaning: '书', phonetic: '' } },
  });
  store.request(
    input,
    'unfinished',
    { profile, text: 'book', normalizedText: 'book', instructions: 'read', target: input.target },
    null,
  );
  runtime = new FakeRuntime();
  service = new MiniAudioService(study, store, runtime, {
    directory: join(directory, 'audio'),
    now,
  });
  assert.equal(service.snapshot().jobs.at(-1)?.status, 'interrupted');
  assert.equal(runtime.calls.length, 0);
  const newRequest = await service.request(input);
  assert.equal(newRequest.job?.status, 'interrupted');
});

async function fakeRuntimeRoot(t: TestContext, body: string) {
  const root = await mkdtemp(join(tmpdir(), 'lingoweave-tts-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'runtime/bin'), { recursive: true });
  await mkdir(join(root, 'models'), { recursive: true });
  const weights = Buffer.from('fixture');
  await writeFile(join(root, 'models', 'weights'), weights);
  await writeFile(
    join(root, 'model-manifest.json'),
    JSON.stringify({
      repository: 'test',
      revision: 'a'.repeat(40),
      directory: 'models',
      files: [
        {
          path: 'weights',
          size: weights.length,
          sha256: createHash('sha256').update(weights).digest('hex'),
        },
      ],
    }),
  );
  await writeFile(
    join(root, 'installation.json'),
    JSON.stringify({ mlx_audio: 'test', mlx: 'test' }),
  );
  await writeFile(join(root, 'runtime/bin/python'), `#!${process.execPath}\n${body}`);
  await chmod(join(root, 'runtime/bin/python'), 0o700);
  return root;
}
test('the speech process rejects malformed worker frames safely and freezes its model profile', async (t) => {
  const root = await fakeRuntimeRoot(
    t,
    "process.stdout.write('not-json\\n');setInterval(()=>{},1000);",
  );
  const runtime = new LocalMiniTtsRuntime(root, { timeoutMs: 1000 });
  t.after(() => runtime.close());
  assert.equal((await runtime.status()).available, true);
  await assert.rejects(
    runtime.generate({
      text: 'apple',
      voice: 'ryan',
      instructions: 'read',
      outputFile: join(root, 'output.wav'),
      signal: new AbortController().signal,
    }),
    (error) => error instanceof LearningError && error.code === 'TTS_GENERATION_FAILED',
  );
  const manifest = JSON.parse(await readFile(join(root, 'model-manifest.json'), 'utf8'));
  manifest.revision = 'b'.repeat(40);
  await writeFile(join(root, 'model-manifest.json'), JSON.stringify(manifest));
  assert.equal((await runtime.status()).available, false);
});

test('speech initialization can be aborted without waiting for the model timeout', async (t) => {
  const root = await fakeRuntimeRoot(t, 'setInterval(()=>{},1000);');
  const runtime = new LocalMiniTtsRuntime(root, { timeoutMs: 5000 });
  t.after(() => runtime.close());
  const controller = new AbortController(),
    started = Date.now();
  const generation = runtime.generate({
    text: 'apple',
    voice: 'ryan',
    instructions: 'read',
    outputFile: join(root, 'output.wav'),
    signal: controller.signal,
  });
  await setImmediate();
  controller.abort();
  await assert.rejects(generation);
  assert.ok(Date.now() - started < 1000);
});
