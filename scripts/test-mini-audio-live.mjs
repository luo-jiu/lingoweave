import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../apps/server/dist/app.js';
import { MiniStore } from '../apps/server/dist/mini-store.js';
import { MiniAudioStore } from '../apps/server/dist/mini-audio-store.js';
import { MiniAudioService, inspectMiniWav } from '../apps/server/dist/mini-audio-service.js';
import { LocalMiniTtsRuntime } from '../apps/server/dist/mini-audio-runtime.js';

// Optional real offline model acceptance. It never uses personal learning databases.
const directory = await mkdtemp(join(tmpdir(), 'lingoweave-audio-live-'));
const studyFile = join(directory, 'mini.sqlite');
const audioFile = join(directory, 'mini-audio.sqlite');
const study = new MiniStore(studyFile);
const audioStore = new MiniAudioStore(audioFile);
const runtime = new LocalMiniTtsRuntime(
  process.env.MINI_TTS_ROOT ?? join(homedir(), 'sdks/lingoweave-tts'),
);
const audio = new MiniAudioService(study, audioStore, runtime, {
  directory: join(directory, 'audio'),
});
const token = 'a'.repeat(64);
const app = buildApp({ mini: { store: study, token, audio } });
const word = { spelling: 'apple', meaning: '苹果', phonetic: '/ˈæpəl/' };
const wordTarget = { kind: 'word', word };
const sentence = {
  word,
  english: 'I eat an apple every morning.',
  chinese: '我每天早晨吃一个苹果。',
};
async function ready(result) {
  if (!result.job) {
    assert.ok(result.asset);
    return result.asset;
  }
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const job = audio.job(result.job.id);
    if (job.status === 'completed') {
      const asset = audioStore.asset(job.assetId);
      const details = inspectMiniWav((await audio.file(asset.id)).data);
      assert.equal(details.sha256, asset.sha256);
      return asset;
    }
    if (!['queued', 'running'].includes(job.status)) throw new Error(job.error ?? job.progress);
    await delay(100);
  }
  throw new Error('The isolated real audio job exceeded its bounded deadline.');
}
try {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const status = await audio.status();
  assert.ok(status.available, status.error ?? 'Local speech runtime unavailable');
  console.log('Offline runtime:', JSON.stringify(status.profile));
  study.importLegacy({
    requestId: randomUUID(),
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
    timezone: 'Asia/Shanghai',
  });
  study.command({
    requestId: randomUUID(),
    expectedRevision: study.snapshot().revision,
    action: { type: 'begin', target: 'daily', deck: [word], timezone: 'Asia/Shanghai' },
  });
  const dayId = study.snapshot().planning.activeDayId;
  assert.ok(dayId);
  study.command({
    requestId: randomUUID(),
    expectedRevision: study.snapshot().revision,
    action: { type: 'add_sentences', target: 'daily', dayId, sentences: [sentence] },
  });
  const initialFacts = study.snapshot();

  const started = Date.now();
  const first = await ready(
    await audio.request({ requestId: randomUUID(), target: wordTarget, operation: 'ensure' }),
  );
  console.log(
    'Actual word:',
    JSON.stringify({
      voice: first.voice,
      seconds: first.durationSeconds,
      elapsedSeconds: (Date.now() - started) / 1000,
    }),
  );
  const jobsBefore = audioStore.jobs().length;
  const reused = await audio.request({
    requestId: randomUUID(),
    target: wordTarget,
    operation: 'ensure',
  });
  assert.equal(reused.asset.id, first.id);
  assert.equal(reused.asset.voice, first.voice);
  assert.equal(audioStore.jobs().length, jobsBefore);
  const download = await fetch(`${address}/api/mini/audio/assets/${first.id}/file`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(download.status, 200);
  assert.equal(inspectMiniWav(Buffer.from(await download.arrayBuffer())).sha256, first.sha256);
  assert.equal((await fetch(`${address}/api/mini/audio/assets/${first.id}/file`)).status, 401);

  const example = await ready(
    await audio.request({
      requestId: randomUUID(),
      target: { kind: 'sentence', sentence },
      operation: 'ensure',
    }),
  );
  console.log(
    'Actual sentence:',
    JSON.stringify({ voice: example.voice, seconds: example.durationSeconds }),
  );
  assert.deepEqual(
    study.snapshot(),
    initialFacts,
    'Generation and cache reads must not fabricate learning or playback.',
  );
  const replacementVoice = first.voice === 'aiden' ? 'ryan' : 'aiden';
  const replacement = await ready(
    await audio.request({
      requestId: randomUUID(),
      target: wordTarget,
      operation: 'regenerate',
      voice: replacementVoice,
    }),
  );
  assert.notEqual(replacement.id, first.id);
  assert.equal(replacement.voice, replacementVoice);
  assert.equal((await audio.lookup(wordTarget)).asset.id, replacement.id);
  assert.equal((await audio.file(first.id)).asset.sha256, first.sha256);
  console.log(
    'Actual single-word regeneration:',
    JSON.stringify({ newVoice: replacement.voice, oldFileRetained: true }),
  );

  const authorization = audio.authorize({
    requestId: randomUUID(),
    assetId: replacement.id,
    visitId: randomUUID(),
    mode: 'automatic',
    context: { target: 'daily', dayId, session: 'learning' },
  });
  assert.equal(authorization.status, 'authorized');
  assert.equal(authorization.startedAt, null);
  assert.ok(study.snapshot().teaching.exposures.some((exposure) => exposure.source === 'audio'));
  assert.equal(
    audio.snapshot().playbacks.filter((playback) => playback.status === 'started').length,
    0,
    'The backend test has not played sound and must not invent a playback start.',
  );
  const expectedStudy = study.snapshot(),
    expectedAudio = audio.snapshot();
  await app.close();
  const reopenedStudy = new MiniStore(studyFile),
    reopenedAudio = new MiniAudioStore(audioFile);
  try {
    assert.deepEqual(reopenedStudy.snapshot(), expectedStudy);
    assert.deepEqual(reopenedAudio.snapshot(), expectedAudio);
  } finally {
    reopenedStudy.close();
    reopenedAudio.close();
  }
  console.log(
    'Live offline audio acceptance passed: real word, sentence, unchanged cached asset/voice, authenticated WAV, single regeneration, old file retained, authorization separate from playback, and both SQLite snapshots reopened exactly.',
  );
} finally {
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
