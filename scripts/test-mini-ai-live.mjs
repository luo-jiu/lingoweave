import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../apps/server/dist/app.js';
import { CodexBridge } from '../apps/server/dist/codex/bridge.js';
import { CodexTransport } from '../apps/server/dist/codex/transport.js';
import { MiniStore } from '../apps/server/dist/mini-store.js';
import { MiniAiStore } from '../apps/server/dist/mini-ai-store.js';
import { MiniAiService } from '../apps/server/dist/mini-ai-service.js';
import { currentTranslation } from '../apps/server/dist/mini-study.js';

if (process.env.MINI_LIVE_TRACE === '1') {
  const request = CodexTransport.prototype.request;
  CodexTransport.prototype.request = async function (method, ...args) {
    try {
      const result = await request.call(this, method, ...args);
      console.log(`Runtime ${method}: acknowledged`);
      return result;
    } catch (error) {
      console.log(`Runtime ${method}: ${error.code ?? 'failed'}`);
      throw error;
    }
  };
}

// Explicitly invoked live acceptance: all learning/chat data is temporary.
const directory = await mkdtemp(join(tmpdir(), 'lingoweave-mini-live-'));
const timezone = 'Asia/Shanghai';
const word = { spelling: 'apple', meaning: '苹果', phonetic: '' };
const studyFile = join(directory, 'mini.sqlite');
const aiFile = join(directory, 'mini-ai.sqlite');
let executable = process.env.CODEX_BIN;
if (!executable) {
  const bundled =
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  try {
    await access(bundled, constants.X_OK);
    executable = bundled;
  } catch {
    executable = 'codex';
  }
}
const study = new MiniStore(studyFile);
const ai = new MiniAiStore(aiFile);
const runtime = new CodexBridge({
  executable,
  cwd: join(directory, 'workspace'),
  turnTimeoutMs: 360_000,
});
const service = new MiniAiService(study, ai, runtime);
const calls = new Map();
const originalTool = service.tool.bind(service);
service.tool = (...args) => {
  try {
    const result = originalTool(...args);
    calls.set(args[2], (calls.get(args[2]) ?? 0) + 1);
    return result;
  } catch (error) {
    console.log(`Live tool ${args[2]}: ${error.code ?? 'failed'}`);
    throw error;
  }
};
const app = buildApp({ mini: { store: study, ai: service, token: 'a'.repeat(64) } });
const act = (action) =>
  study.command({ requestId: randomUUID(), expectedRevision: study.snapshot().revision, action });
const day = () => study.snapshot().ledger.days.at(-1);
async function run(kind, fields = {}) {
  const started = service.start({
    requestId: randomUUID(),
    kind,
    timezone,
    conversationId: 'advisor',
    model: 'gpt-6.1-sol',
    effort: 'xhigh',
    ...fields,
  });
  console.log(`Live ${kind}: started`);
  const deadline = Date.now() + 480_000;
  let previousProgress = '';
  while (Date.now() < deadline) {
    const job = ai.job(started.id);
    if (job.progress !== previousProgress) {
      console.log(`Live ${kind}: ${job.progress}`);
      previousProgress = job.progress;
    }
    if (!['queued', 'running'].includes(job.status)) {
      assert.equal(job.status, 'completed', `${kind}: ${job.error ?? job.progress}`);
      assert.ok(job.receipts.length > 0, `${kind} must save through a real tool receipt`);
      assert.equal(job.model, 'gpt-6.1-sol');
      assert.equal(job.effort, 'xhigh');
      console.log(`Live ${kind}: completed with ${job.receipts.length} saved receipts`);
      return job;
    }
    await delay(500);
  }
  throw new Error(`Live ${kind} exceeded its bounded deadline (${ai.job(started.id).status}).`);
}

try {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  service.setBaseUrl(address);
  study.importLegacy({
    requestId: randomUUID(),
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
    timezone,
  });
  ai.importLegacy({ requestId: randomUUID(), conversations: [] });
  const status = await runtime.status();
  console.log(
    'Live runtime:',
    JSON.stringify({
      node: process.version,
      available: status.available,
      authenticated: status.authenticated,
      version: status.version,
      selected: status.models.find((model) => model.id === 'gpt-6.1-sol'),
      error: status.error,
    }),
  );
  assert.ok(status.available && status.authenticated, status.error ?? 'Codex login unavailable');
  assert.ok(
    status.models.some(
      (model) => model.id === 'gpt-6.1-sol' && model.supportedReasoningEfforts?.includes('xhigh'),
    ),
    'The exact selected model and effort must be available; no fallback.',
  );

  if (process.env.MINI_LIVE_TEACHING_ONLY !== '1') {
    await run('advisor', {
      message:
        '请先通过历史查询查看实际学习记录，再把今天的学习计划设为总共3个词、其中最多1个新词，只改今天。另请将我的英语学习水平偏好记为A2，保存后简短告诉我结果。',
    });
    const preview = study.planPreview({ deck: [word], timezone });
    assert.equal(preview.planContext.effective.wordLimit, 3);
    assert.equal(preview.planContext.effective.newWordLimit, 1);
    assert.ok(
      study
        .snapshot()
        .teaching.memories.some(
          (memory) => memory.key === 'english_level' && memory.value === 'A2',
        ),
    );
    assert.ok(
      calls.get('history') > 0,
      'The advisor must read actual history when explicitly requested.',
    );
  }

  act({ type: 'begin', target: 'daily', deck: [word], timezone });
  const dayId = day().id;
  if (process.env.MINI_LIVE_TEACHING_ONLY === '1') {
    act({
      type: 'add_sentences',
      target: 'daily',
      dayId,
      sentences: [{ word, english: 'I eat an apple.', chinese: '我吃一个苹果。' }],
    });
  } else await run('prepare', { dayId });
  const learningSentence = day().sentences[0];
  assert.ok(learningSentence);
  act({ type: 'mark_studied', target: 'daily', dayId, word });
  for (let index = 0; index < 4 && day().learning.phase !== 'finished'; index++)
    act({
      type: 'submit_spelling',
      target: 'daily',
      dayId,
      session: 'learning',
      word,
      answer: word.spelling,
    });
  act({ type: 'complete_learning', target: 'daily', dayId });
  await run('writing', { dayId });
  const task = currentTranslation(day());
  assert.ok(task?.materialId);
  assert.notDeepEqual(task.sentence, learningSentence);
  const schedule = structuredClone(day().scheduleUpdates);
  const answer = task.direction === 'englishToChinese' ? '我想吃一个苹果。' : 'I want an apple.';
  act({ type: 'submit_translation', target: 'daily', dayId, taskId: task.id, answer });
  const attempt = day().translation.at(-1);
  assert.ok(attempt);
  await run('feedback', { dayId, attemptId: attempt.id });
  const saved = day().translation.find((item) => item.id === attempt.id);
  assert.equal(saved.answer, answer);
  assert.ok(saved.feedback?.strengths && saved.feedback.improvements && saved.feedback.keyPoints);
  assert.equal(saved.feedback.outcome, undefined);
  assert.deepEqual(day().scheduleUpdates, schedule);
  const expectedStudy = study.snapshot(),
    expectedAi = ai.snapshot();
  await app.close();
  const reopenedStudy = new MiniStore(studyFile),
    reopenedAi = new MiniAiStore(aiFile);
  try {
    assert.deepEqual(reopenedStudy.snapshot(), expectedStudy);
    assert.deepEqual(reopenedAi.snapshot(), expectedAi);
  } finally {
    reopenedStudy.close();
    reopenedAi.close();
  }
  console.log(
    process.env.MINI_LIVE_TEACHING_ONLY === '1'
      ? 'Live writing/feedback acceptance passed: selected runtime, independent writing, qualitative feedback, unchanged original answer/schedule, and SQLite reopen. Learning material was an explicit isolated fixture.'
      : 'Live four-task acceptance passed: selected runtime, history, today plan, explicit memory, learning material, independent writing, qualitative feedback, unchanged original answer/schedule, and SQLite reopen.',
  );
} finally {
  console.log('Live final tool counts:', JSON.stringify(Object.fromEntries(calls)));
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
