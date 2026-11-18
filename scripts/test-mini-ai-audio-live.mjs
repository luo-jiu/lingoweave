import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../apps/server/dist/app.js';
import { CodexBridge } from '../apps/server/dist/codex/bridge.js';
import { MiniStore } from '../apps/server/dist/mini-store.js';
import { MiniAiStore } from '../apps/server/dist/mini-ai-store.js';
import { MiniAiService } from '../apps/server/dist/mini-ai-service.js';
import { MiniAudioStore } from '../apps/server/dist/mini-audio-store.js';
import { MiniAudioService, inspectMiniWav } from '../apps/server/dist/mini-audio-service.js';
import { LocalMiniTtsRuntime } from '../apps/server/dist/mini-audio-runtime.js';

// Explicitly invoked real Codex + offline TTS acceptance. All facts and assets are disposable.
const directory = await mkdtemp(join(tmpdir(), 'lingoweave-ai-audio-live-'));
const studyFile = join(directory, 'mini.sqlite');
const aiFile = join(directory, 'mini-ai.sqlite');
const audioFile = join(directory, 'mini-audio.sqlite');
const timezone = 'Asia/Shanghai';
const word = { spelling: 'apple', meaning: '苹果', phonetic: '/ˈæpəl/' };
const target = { kind: 'word', word };
const sentence = {
  word,
  english: 'I eat an apple every morning.',
  chinese: '我每天早晨吃一个苹果。',
};
let executable = process.env.CODEX_BIN;
if (!executable) {
  for (const candidate of [
    '/Applications/Codex.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  ]) {
    try {
      await access(candidate, constants.X_OK);
      executable = candidate;
      break;
    } catch {
      // Try the next existing app runtime; no installation or global configuration change.
    }
  }
}
const study = new MiniStore(studyFile);
const aiStore = new MiniAiStore(aiFile);
const audioStore = new MiniAudioStore(audioFile);
const speech = new LocalMiniTtsRuntime(
  process.env.MINI_TTS_ROOT ?? join(homedir(), 'sdks/lingoweave-tts'),
);
const audio = new MiniAudioService(study, audioStore, speech, {
  directory: join(directory, 'audio'),
});
const runtime = new CodexBridge({
  executable: executable ?? 'codex',
  cwd: join(directory, 'workspace'),
  turnTimeoutMs: 360_000,
});
const expectedTools = [
  'learning_get_context',
  'learning_get_history',
  'learning_get_word',
  'learning_commit',
  'learning_get_audio',
  'learning_generate_audio',
];
const prepare = runtime.prepare.bind(runtime);
let verifiedToolInventory = false;
runtime.prepare = async (options) => {
  assert.deepEqual([...options.tools].sort(), [...expectedTools].sort());
  assert.equal(options.model, 'gpt-6.1-sol');
  assert.equal(options.effort, 'xhigh');
  const result = await prepare(options);
  // CodexBridge rejects missing, extra or foreign tools before starting its model turn.
  verifiedToolInventory = true;
  return result;
};
const service = new MiniAiService(study, aiStore, runtime, audio);
const tool = service.tool.bind(service);
const calls = [];
service.tool = async (...args) => {
  const result = await tool(...args);
  const action = args[2];
  const input = args[3];
  const summary = { action };
  if (action === 'audio_request') {
    summary.operation = input.operation;
    summary.voice = input.voice;
    summary.kind = input.target.kind;
    summary.jobId = result.job?.id ?? null;
    summary.status = result.job?.status ?? 'cached';
  }
  calls.push(summary);
  console.log('Actual tool:', JSON.stringify(summary));
  return result;
};
const app = buildApp({ mini: { store: study, token: 'a'.repeat(64), ai: service, audio } });
const act = (action) =>
  study.command({ requestId: randomUUID(), expectedRevision: study.snapshot().revision, action });

async function waitAudio(id) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const job = audio.job(id);
    if (job.status === 'completed') {
      const asset = audioStore.asset(job.assetId);
      assert.equal(inspectMiniWav((await audio.file(asset.id)).data).sha256, asset.sha256);
      return asset;
    }
    assert.ok(['queued', 'running'].includes(job.status), job.error ?? job.progress);
    await delay(200);
  }
  throw new Error('The real isolated audio generation exceeded its bounded deadline.');
}

try {
  console.log('Isolated live process:', process.pid);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  service.setBaseUrl(address);
  study.importLegacy({
    requestId: randomUUID(),
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
    timezone,
  });
  aiStore.importLegacy({ requestId: randomUUID(), conversations: [] });
  act({ type: 'begin', target: 'daily', deck: [word], timezone });
  const dayId = study.snapshot().planning.activeDayId;
  assert.ok(dayId);
  act({ type: 'add_sentences', target: 'daily', dayId, sentences: [sentence] });
  const initialFacts = study.snapshot();
  const speechStatus = await audio.status();
  assert.ok(speechStatus.available, speechStatus.error ?? 'Offline speech unavailable');
  const initial = await audio.request({
    requestId: randomUUID(),
    target,
    operation: 'ensure',
    voice: 'aiden',
  });
  assert.ok(initial.job);
  const original = await waitAudio(initial.job.id);
  assert.equal(original.voice, 'aiden');
  assert.deepEqual(study.snapshot(), initialFacts);
  console.log(
    'Real seed cache ready:',
    JSON.stringify({ voice: original.voice, seconds: original.durationSeconds }),
  );

  const status = await runtime.status();
  const selected = status.models.find((model) => model.id === 'gpt-6.1-sol');
  console.log(
    'Real Codex runtime:',
    JSON.stringify({
      available: status.available,
      authenticated: status.authenticated,
      version: status.version,
      selected,
      error: status.error,
    }),
  );
  assert.ok(status.available && status.authenticated, status.error ?? 'Codex login unavailable');
  assert.ok(
    selected?.supportedReasoningEfforts?.includes('xhigh'),
    'The exact requested model and effort must be supported; no fallback.',
  );
  const job = service.start({
    requestId: randomUUID(),
    kind: 'advisor',
    timezone,
    dayId,
    word,
    conversationId: 'audio-live',
    model: 'gpt-6.1-sol',
    effort: 'xhigh',
    message:
      '请先查询 apple（苹果）的单词音频缓存，再仅将这个单词重新生成，指定 serena；别播放、别改例句或学习计划，并说明实际任务状态。',
  });
  console.log('Real advisor audio task started.');
  let progress = '';
  const deadline = Date.now() + 480_000;
  while (Date.now() < deadline) {
    const current = aiStore.job(job.id);
    if (current.progress !== progress) {
      progress = current.progress;
      console.log('Advisor progress:', progress);
    }
    if (!['queued', 'running'].includes(current.status)) break;
    await delay(500);
  }
  const completed = aiStore.job(job.id);
  assert.equal(completed.status, 'completed', completed.error ?? completed.progress);
  assert.ok(verifiedToolInventory);
  assert.ok(calls.some((call) => call.action === 'audio_status'));
  const requests = calls.filter((call) => call.action === 'audio_request');
  assert.ok(requests.length > 0, 'The actual advisor must call the scoped audio generation tool.');
  assert.ok(
    requests.every(
      (call) => call.kind === 'word' && call.operation === 'regenerate' && call.voice === 'serena',
    ),
  );
  assert.equal(
    new Set(requests.map((call) => call.jobId)).size,
    1,
    'The advisor must regenerate exactly one recording.',
  );
  assert.ok(completed.receipts.some((receipt) => receipt.tool === 'learning_generate_audio'));
  const regenerated = audioStore.jobs().filter((entry) => entry.operation === 'regenerate');
  assert.equal(regenerated.length, 1);
  const replacement = await waitAudio(regenerated[0].id);
  assert.equal(replacement.voice, 'serena');
  assert.notEqual(replacement.id, original.id);
  assert.equal((await audio.lookup(target)).asset.id, replacement.id);
  assert.equal((await audio.file(original.id)).asset.sha256, original.sha256);
  assert.equal(audioStore.assets().length, 2);
  assert.ok(audioStore.assets().every((asset) => asset.target.kind === 'word'));
  assert.deepEqual(audio.snapshot().playbacks, []);
  const after = study.snapshot();
  assert.deepEqual(
    after.ledger,
    initialFacts.ledger,
    'Audio tools cannot change examples, answers, group progress or schedules.',
  );
  assert.deepEqual(after.planning, initialFacts.planning);
  assert.deepEqual(after.reviewRecord, initialFacts.reviewRecord);
  assert.deepEqual(after.reviewHistory, initialFacts.reviewHistory);
  assert.deepEqual(after.teaching.focusItems, initialFacts.teaching.focusItems);
  assert.deepEqual(after.teaching.memories, initialFacts.teaching.memories);
  assert.ok(
    after.teaching.exposures.every(
      (exposure) => exposure.source === 'chat' && exposure.kind === 'potentialHelp',
    ),
  );
  const expectedStudy = study.snapshot(),
    expectedAi = aiStore.snapshot(),
    expectedAudio = audio.snapshot();
  await app.close();
  const reopenedStudy = new MiniStore(studyFile),
    reopenedAi = new MiniAiStore(aiFile),
    reopenedAudio = new MiniAudioStore(audioFile);
  try {
    assert.deepEqual(reopenedStudy.snapshot(), expectedStudy);
    assert.deepEqual(reopenedAi.snapshot(), expectedAi);
    assert.deepEqual(reopenedAudio.snapshot(), expectedAudio);
  } finally {
    reopenedStudy.close();
    reopenedAi.close();
    reopenedAudio.close();
  }
  console.log(
    'Real AI audio acceptance passed:',
    JSON.stringify({
      model: completed.model,
      effort: completed.effort,
      toolInventory: 6,
      audioStatusCalls: calls.filter((call) => call.action === 'audio_status').length,
      audioRequestCalls: requests.length,
      receipts: completed.receipts.length,
      newVoice: replacement.voice,
      actualAudioSeconds: replacement.durationSeconds,
      oldFileRetained: true,
      unchangedLearningFacts: true,
      played: false,
      sqliteReopenExact: true,
    }),
  );
} finally {
  console.log('Final successful tool types:', JSON.stringify(calls.map((call) => call.action)));
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
