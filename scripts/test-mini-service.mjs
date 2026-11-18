import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../apps/server/dist/app.js';
import { MiniStore } from '../apps/server/dist/mini-store.js';
import { MiniAiStore } from '../apps/server/dist/mini-ai-store.js';
import { MiniAiService } from '../apps/server/dist/mini-ai-service.js';
import { MiniAudioStore } from '../apps/server/dist/mini-audio-store.js';
import { MiniAudioService } from '../apps/server/dist/mini-audio-service.js';

// A short valid waveform for protocol tests; it is not synthesized speech.
function audioFixture() {
  const rate = 24000,
    samples = 4800;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++)
    bytes.writeInt16LE(
      Math.round(Math.sin((index * 2 * Math.PI * 440) / rate) * 2000),
      44 + index * 2,
    );
  return bytes;
}
class NativeAudioRuntime {
  async status() {
    return {
      available: true,
      profile: {
        modelId: 'isolated-native-audio-test',
        modelRevision: 'fixture-v1',
        engine: 'mlx-audio',
        engineVersion: 'test',
        generationVersion: 'test',
        language: 'English',
        temperature: 0.7,
        maxTokens: 2048,
      },
      error: null,
    };
  }
  async generate(input) {
    await writeFile(input.outputFile, audioFixture(), { flag: 'wx' });
  }
  async close() {}
}

// The native integration uses real authenticated HTTP and SQLite, with no model calls.
class NativeTestRuntime {
  async status() {
    return {
      available: true,
      authenticated: true,
      version: 'native-test',
      models: [
        {
          id: 'gpt-6.1-sol',
          name: 'Isolated native test runtime',
          isDefault: true,
          supportedReasoningEfforts: ['xhigh'],
          defaultReasoningEffort: 'xhigh',
        },
      ],
      error: null,
    };
  }

  async prepare(options) {
    const call = async (action, input) => {
      const response = await fetch(options.mcp.env.LINGOWEAVE_MINI_AI_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.mcp.env.LINGOWEAVE_MINI_AI_TOKEN}`,
        },
        body: JSON.stringify({ action, input }),
        signal: options.signal,
      });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    };
    const context = await call('context');
    const kind = context.job.kind;
    options.onThread?.({ threadId: `native-test-${options.jobId}`, model: 'gpt-6.1-sol' });
    options.onProgress(`隔离测试：${kind}`);
    let action;
    if (kind === 'advisor') {
      action = {
        type: 'set_today_plan',
        target: 'daily',
        date: context.date,
        timezone: context.timezone,
        mode: 'normal',
        wordLimit: 3,
        newWordLimit: 1,
      };
    } else {
      assert.ok(context.day, 'A teaching task must reference a real saved group.');
      const dayId = context.day.id;
      if (kind === 'prepare') {
        const words = context.day.learningWords.filter(
          (word) =>
            !context.day.sentences.some((sentence) => sentence.word.spelling === word.spelling),
        );
        action = {
          type: 'add_sentences',
          target: 'daily',
          dayId,
          sentences: words.map((word) => ({
            word,
            english: `I see an ${word.spelling}.`,
            chinese: `我看见一个${word.meaning}。`,
          })),
        };
      } else if (kind === 'writing') {
        action = {
          type: 'publish_writing',
          target: 'daily',
          dayId,
          prompts: [...context.day.reviewWords, ...context.day.learningWords].map(
            (word, index) => ({
              id: randomUUID(),
              sentence: {
                word,
                english: `The ${word.spelling} is on the table.`,
                chinese: `这个${word.meaning}在桌上。`,
              },
              direction: context.day.directions[index],
              focusIds: [],
            }),
          ),
        };
      } else {
        assert.equal(kind, 'feedback');
        assert.ok(context.day.attempt, 'Feedback must read the original submitted answer.');
        action = {
          type: 'qualitative_feedback',
          target: 'daily',
          dayId,
          attemptId: context.day.attempt.id,
          feedback: {
            comment: '主要意思和位置关系表达清楚。',
            tip: '可以换一个物品，再练习同一个位置表达。',
            usefulPhrase: 'on the table · 在桌上',
            strengths: ['保留了位置关系。'],
            improvements: [],
            keyPoints: ['on 表示在物体表面。'],
            referenceTranslation:
              context.day.attempt.task.direction === 'englishToChinese'
                ? context.day.attempt.task.sentence.chinese
                : context.day.attempt.task.sentence.english,
          },
        };
      }
    }
    await call('commit', { requestId: randomUUID(), expectedRevision: context.revision, action });
    options.onText('隔离测试已完成，结果由业务工具保存。');
    return { threadId: `native-test-${options.jobId}`, model: 'gpt-6.1-sol' };
  }

  async close() {}
}

const directory = await mkdtemp(join(tmpdir(), 'lingoweave-mini-integration-'));
const database = join(directory, 'mini.sqlite');
const tokenFile = join(directory, 'token');
const token = randomBytes(32).toString('hex');
const groupsDatabase = join(directory, 'groups.sqlite');
const groupsTokenFile = join(directory, 'groups-token');
const groupsToken = randomBytes(32).toString('hex');
const aiStudyDatabase = join(directory, 'ai-study.sqlite');
const aiDatabase = join(directory, 'ai.sqlite');
const aiTokenFile = join(directory, 'ai-token');
const aiToken = randomBytes(32).toString('hex');
const audioStudyDatabase = join(directory, 'audio-study.sqlite');
const audioDatabase = join(directory, 'audio.sqlite');
const audioTokenFile = join(directory, 'audio-token');
const audioToken = randomBytes(32).toString('hex');
const flowDatabase = join(directory, 'flow-study.sqlite');
const flowTokenFile = join(directory, 'flow-token');
const flowToken = randomBytes(32).toString('hex');
await Promise.all([
  writeFile(tokenFile, token, { mode: 0o600 }),
  writeFile(groupsTokenFile, groupsToken, { mode: 0o600 }),
  writeFile(aiTokenFile, aiToken, { mode: 0o600 }),
  writeFile(audioTokenFile, audioToken, { mode: 0o600 }),
  writeFile(flowTokenFile, flowToken, { mode: 0o600 }),
]);
const store = new MiniStore(database);
const app = buildApp({ mini: { store, token } });
// Isolated transport checks never execute a learning command.
const saveRetryAttempts = new Map();
app.post('/api/mini/test-save-retries', async (request, reply) => {
  assert.equal(request.headers.authorization, `Bearer ${token}`);
  const input = request.body;
  assert.equal(typeof input.requestId, 'string');
  const attempts = (saveRetryAttempts.get(input.requestId) ?? 0) + 1;
  saveRetryAttempts.set(input.requestId, attempts);
  const status =
    input.mode === 'conflict' ? 409 : input.mode === 'exhausted' || attempts < 4 ? 503 : 200;
  return reply.code(status).send({ requestId: input.requestId, attempts });
});
app.get('/api/mini/test-save-retries/:id', async (request) => {
  assert.equal(request.headers.authorization, `Bearer ${token}`);
  return { requestId: request.params.id, attempts: saveRetryAttempts.get(request.params.id) ?? 0 };
});
const flowStore = new MiniStore(flowDatabase);
const flowApp = buildApp({ mini: { store: flowStore, token: flowToken } });
flowApp.addHook('onSend', async (request, reply, payload) => {
  if (reply.statusCode >= 400)
    console.error('Native v2 flow integration request failed:', request.url, payload);
  return payload;
});
app.addHook('onSend', async (request, reply, payload) => {
  if (reply.statusCode >= 400)
    console.error('Native study integration request failed:', request.url, payload);
  return payload;
});
const groupsStore = new MiniStore(groupsDatabase);
const groupsApp = buildApp({ mini: { store: groupsStore, token: groupsToken } });
const aiStudyStore = new MiniStore(aiStudyDatabase);
const aiStore = new MiniAiStore(aiDatabase);
const aiService = new MiniAiService(aiStudyStore, aiStore, new NativeTestRuntime());
const aiApp = buildApp({ mini: { store: aiStudyStore, token: aiToken, ai: aiService } });
const audioStudyStore = new MiniStore(audioStudyDatabase);
const audioStore = new MiniAudioStore(audioDatabase);
const audioService = new MiniAudioService(audioStudyStore, audioStore, new NativeAudioRuntime(), {
  directory: join(directory, 'audio'),
});
const audioApp = buildApp({
  mini: { store: audioStudyStore, token: audioToken, audio: audioService },
});
audioApp.addHook('onSend', async (request, reply, payload) => {
  if (reply.statusCode >= 400)
    console.error('Native audio integration request failed:', request.url, payload);
  return payload;
});
aiApp.addHook('onSend', async (request, reply, payload) => {
  if (reply.statusCode >= 400)
    console.error('Native AI integration request failed:', request.url, payload);
  return payload;
});

try {
  const [address, groupsAddress, aiAddress, audioAddress, flowAddress] = await Promise.all([
    app.listen({ host: '127.0.0.1', port: 0 }),
    groupsApp.listen({ host: '127.0.0.1', port: 0 }),
    aiApp.listen({ host: '127.0.0.1', port: 0 }),
    audioApp.listen({ host: '127.0.0.1', port: 0 }),
    flowApp.listen({ host: '127.0.0.1', port: 0 }),
  ]);
  aiService.setBaseUrl(aiAddress);
  const testScript = fileURLToPath(new URL('../apps/macos/test-review.sh', import.meta.url));
  const child = spawn('/bin/bash', [testScript], {
    stdio: 'inherit',
    env: {
      ...process.env,
      MINI_TEST_SERVICE_URL: address,
      MINI_TEST_TOKEN_PATH: tokenFile,
      MINI_TEST_GROUPS_SERVICE_URL: groupsAddress,
      MINI_TEST_GROUPS_TOKEN_PATH: groupsTokenFile,
      MINI_TEST_AI_SERVICE_URL: aiAddress,
      MINI_TEST_AI_TOKEN_PATH: aiTokenFile,
      MINI_TEST_AUDIO_SERVICE_URL: audioAddress,
      MINI_TEST_AUDIO_TOKEN_PATH: audioTokenFile,
      MINI_TEST_FLOW_SERVICE_URL: flowAddress,
      MINI_TEST_FLOW_TOKEN_PATH: flowTokenFile,
    },
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 0, 'The native client must complete all five real HTTP flows.');
  const committed = store.snapshot();
  const groupsCommitted = groupsStore.snapshot();
  const aiStudyCommitted = aiStudyStore.snapshot();
  const aiCommitted = aiStore.snapshot();
  const audioStudyCommitted = audioStudyStore.snapshot();
  const audioCommitted = audioStore.snapshot();
  const flowCommitted = flowStore.snapshot();
  assert.ok(
    flowCommitted.ledger.days.some((day) => day.flow?.version === 'sliding-window-v2'),
    'The v2 native flow must preserve its sliding-window learning facts.',
  );
  assert.ok(
    flowCommitted.assessmentSources.length > 0,
    'Translation next must save assessment inputs without waiting for a model.',
  );
  assert.ok(
    audioCommitted.assets.length > 0,
    'The audio flow must save a real validated waveform asset.',
  );
  assert.ok(
    audioCommitted.playbacks.some((playback) => playback.status === 'started'),
    'The audio flow must separately acknowledge its controlled playback start.',
  );
  assert.ok(committed.ledger.days.some((day) => day.phase === 'finished'));
  assert.equal(committed.ledger.days.at(-1)?.learning?.phase, 'finished');
  assert.ok(
    groupsCommitted.ledger.days.length >= 3,
    'The second native flow must preserve its original groups.',
  );
  assert.deepEqual(
    new Set(aiCommitted.jobs.filter((job) => job.status === 'completed').map((job) => job.kind)),
    new Set(['advisor', 'prepare', 'writing', 'feedback']),
    'The third native flow must commit every supported AI task kind.',
  );
  await Promise.all([
    app.close(),
    groupsApp.close(),
    aiApp.close(),
    audioApp.close(),
    flowApp.close(),
  ]);
  for (const [filename, expected] of [
    [database, committed],
    [groupsDatabase, groupsCommitted],
    [aiStudyDatabase, aiStudyCommitted],
    [audioStudyDatabase, audioStudyCommitted],
    [flowDatabase, flowCommitted],
  ]) {
    const reopened = new MiniStore(filename);
    try {
      assert.deepEqual(reopened.snapshot(), expected);
    } finally {
      reopened.close();
    }
  }
  const reopenedAI = new MiniAiStore(aiDatabase);
  try {
    assert.deepEqual(reopenedAI.snapshot(), aiCommitted);
  } finally {
    reopenedAI.close();
  }
  const reopenedAudio = new MiniAudioStore(audioDatabase);
  try {
    assert.deepEqual(reopenedAudio.snapshot(), audioCommitted);
  } finally {
    reopenedAudio.close();
  }
  console.log(
    'All five native study stores, the AI store and the audio store survived SQLite close and reopen.',
  );
} finally {
  await Promise.allSettled([
    app.close(),
    groupsApp.close(),
    aiApp.close(),
    audioApp.close(),
    flowApp.close(),
  ]);
  store.close();
  groupsStore.close();
  aiStudyStore.close();
  audioStudyStore.close();
  flowStore.close();
  await rm(directory, { recursive: true, force: true });
}
