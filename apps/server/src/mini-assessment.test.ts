import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  miniAssessmentSourceSchema,
  type MiniAssessmentApplication,
  type MiniAssessmentReceipt,
  type MiniAssessmentResult,
  type MiniAssessmentSource,
  type MiniAction,
  type RuntimeStatus,
} from '@lingoweave/contracts';
import { MiniAssessmentStore, miniAssessmentHash } from './mini-assessment-store.js';
import { MiniAssessmentService, type MiniAssessmentRepository } from './mini-assessment-service.js';
import { MiniAiStore } from './mini-ai-store.js';
import type { PreparationRuntime } from './preparation-service.js';
import { LearningError } from './learning-store.js';
import { buildApp } from './app.js';
import { MiniStore } from './mini-store.js';
import {
  currentMiniWindow,
  currentTranslation,
  miniPreparationWords,
  miniWritingWords,
} from './mini-study.js';

type RuntimeOptions = Parameters<PreparationRuntime['prepare']>[0];
const now = () => new Date('2026-11-17T06:00:00Z');
function source(): MiniAssessmentSource {
  const id = randomUUID();
  return miniAssessmentSourceSchema.parse({
    schemaVersion: 1,
    id,
    dayId: '2026-11-17',
    attemptId: id,
    word: { spelling: 'bag', meaning: '包', phonetic: '' },
    timezone: 'Asia/Shanghai',
    question: {
      id: '2026-11-17/0',
      direction: 'chineseToEnglish',
      english: 'My bag is blue.',
      chinese: '我的包是蓝色的。',
    },
    answer: 'My bag is blue.',
    submittedAt: 816501590,
    confirmedAt: 816501600,
    learningEvidence: {
      firstSpelling: { id: randomUUID(), answer: 'bag', correct: true },
      memory: [],
    },
    discussion: [],
  });
}
function result(input: MiniAssessmentSource): MiniAssessmentResult {
  const observation = {
    outcome: 'correct' as const,
    explanation: '原答使用了正确的目标词。',
    evidenceIds: [input.attemptId],
  };
  return {
    sourceId: input.id,
    inputHash: miniAssessmentHash(input),
    meaning: observation,
    spelling: observation,
    usage: observation,
    summary: '目标词使用正确。',
    strengths: ['意思清楚。'],
    improvements: [],
    referenceTranslation: 'My bag is blue.',
    uncertainties: [],
  };
}
class Repository implements MiniAssessmentRepository {
  readonly sources = new Map<string, MiniAssessmentSource>();
  readonly adopted = new Map<string, MiniAssessmentReceipt>();
  readonly applications: MiniAssessmentApplication[] = [];
  unavailable = false;
  pending() {
    return [...this.sources.values()].filter((item) => !this.adopted.has(item.id));
  }
  get(id: string) {
    return this.sources.get(id);
  }
  apply(application: MiniAssessmentApplication): MiniAssessmentReceipt {
    if (this.unavailable)
      throw new LearningError('DATABASE_BUSY', '正在保存其他学习记录，请重试。');
    const old = this.adopted.get(application.requestId);
    if (old) return old;
    assert.deepEqual(application.source, this.get(application.source.id));
    const receipt: MiniAssessmentReceipt = {
      requestId: application.requestId,
      sourceId: application.source.id,
      revision: this.adopted.size + 1,
      disposition: 'adopted',
      reason: '已依据原始证据采用。',
      scheduling: { before: { due: '2026-11-18' }, after: { due: '2026-11-18' } },
    };
    this.adopted.set(application.requestId, receipt);
    this.applications.push(application);
    return receipt;
  }
}
class Runtime implements PreparationRuntime {
  readonly calls: RuntimeOptions[] = [];
  behavior: (options: RuntimeOptions) => Promise<void> = async () => {};
  supported = true;
  async status(): Promise<RuntimeStatus> {
    return {
      available: true,
      authenticated: true,
      version: 'test',
      models: [
        {
          id: 'gpt-6.1-sol',
          name: 'test',
          isDefault: true,
          supportedReasoningEfforts: this.supported ? ['xhigh'] : ['high'],
        },
      ],
      error: null,
    };
  }
  async prepare(options: RuntimeOptions) {
    this.calls.push(options);
    options.onThread?.({ threadId: `thread-${options.jobId}`, model: 'gpt-6.1-sol' });
    await this.behavior(options);
    return { threadId: `thread-${options.jobId}`, model: 'gpt-6.1-sol' };
  }
  async close() {}
}
function fixture(t: TestContext) {
  const repository = new Repository();
  const store = new MiniAssessmentStore(':memory:', now);
  const runtime = new Runtime();
  const service = new MiniAssessmentService(repository, store, runtime, now);
  t.after(() => service.close());
  const call = (options: RuntimeOptions, action: string, input: unknown = {}) => {
    const token = options.mcp.env.LINGOWEAVE_MINI_ASSESSMENT_TOKEN;
    assert.ok(token);
    return service.tool(options.jobId, token, action, input);
  };
  const submit = (
    options: RuntimeOptions,
    assessment?: MiniAssessmentResult,
    requestId = randomUUID(),
  ) => {
    call(options, 'context');
    const original = repository.get(options.jobId);
    assert.ok(original);
    return call(options, 'commit', { requestId, result: assessment ?? result(original) });
  };
  return { repository, store, runtime, service, call, submit };
}
async function finished(service: MiniAssessmentService, count = 1) {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    const state = service.snapshot();
    if (state.jobs.length >= count && state.pendingCount === 0 && state.runningCount === 0)
      return state;
    await setImmediate();
  }
  assert.fail('assessment queue did not settle');
}
const hasCode = (code: string) => (error: unknown) =>
  error instanceof LearningError && error.code === code;

test('confirmed answers dispatch without opening home and preserve the original answer and audit', async (t) => {
  const f = fixture(t);
  const first = source(),
    second = source();
  f.repository.sources.set(first.id, first);
  f.repository.sources.set(second.id, second);
  f.runtime.behavior = async (options) => {
    assert.equal(options.model, 'gpt-6.1-sol');
    assert.equal(options.effort, 'xhigh');
    assert.deepEqual(options.tools, ['learning_get_assessment', 'learning_submit_assessment']);
    f.submit(options);
  };
  f.service.setBaseUrl('http://127.0.0.1:12345');
  await finished(f.service, 2);
  assert.equal(f.repository.applications.length, 2);
  assert.equal(f.runtime.calls.length, 2);
  assert.deepEqual(f.service.detail(first.id).source, first);
  const trace = f.service.detail(first.id).application?.trace;
  assert.equal(trace?.model, 'gpt-6.1-sol');
  assert.equal(trace?.rulesVersion, 'mini-assessment-v1');
  assert.match(trace?.skillHash ?? '', /^[a-f0-9]{64}$/);
  assert.match(trace?.promptHash ?? '', /^[a-f0-9]{64}$/);
  assert.equal(f.service.detail(first.id).job.receipt?.revision, 1);
});

test('assessment tools enforce task credentials, context, frozen source and evidence identity', async (t) => {
  const f = fixture(t),
    original = source();
  f.repository.sources.set(original.id, original);
  f.runtime.behavior = async (options) => {
    assert.throws(
      () => f.service.tool(options.jobId, 'bad-token', 'context', {}),
      hasCode('ASSESSMENT_TASK_EXPIRED'),
    );
    assert.throws(
      () => f.call(options, 'commit', { requestId: randomUUID(), result: result(original) }),
      hasCode('ASSESSMENT_CONTEXT_REQUIRED'),
    );
    f.call(options, 'context');
    assert.throws(
      () =>
        f.call(options, 'commit', {
          requestId: randomUUID(),
          result: { ...result(original), sourceId: randomUUID() },
        }),
      hasCode('ASSESSMENT_TARGET_INVALID'),
    );
    const invalid = result(original);
    invalid.meaning = { ...invalid.meaning, evidenceIds: ['invented-history'] };
    assert.throws(() => f.submit(options, invalid), hasCode('ASSESSMENT_EVIDENCE_INVALID'));
    assert.throws(() => f.call(options, 'history'), hasCode('ASSESSMENT_TOOL_INVALID'));
    f.submit(options);
  };
  f.service.setBaseUrl('http://127.0.0.1:12345');
  await finished(f.service);
  assert.equal(f.repository.applications.length, 1);
  assert.equal(f.service.detail(original.id).job.status, 'completed');
});

test('a saved result stays completed when the runtime final response fails', async (t) => {
  const f = fixture(t),
    original = source();
  f.repository.sources.set(original.id, original);
  f.runtime.behavior = async (options) => {
    const requestId = randomUUID();
    f.submit(options, result(original), requestId);
    f.submit(options, result(original), requestId);
    throw new Error('transport disconnected after commit');
  };
  f.service.setBaseUrl('http://127.0.0.1:12345');
  await finished(f.service);
  assert.equal(f.service.detail(original.id).job.status, 'completed');
  assert.equal(f.repository.applications.length, 1);
});

test('failed learning adoption retries the saved candidate without another model call', async (t) => {
  const f = fixture(t),
    original = source();
  f.repository.sources.set(original.id, original);
  f.repository.unavailable = true;
  f.runtime.behavior = async (options) => {
    f.submit(options);
  };
  f.service.setBaseUrl('http://127.0.0.1:12345');
  await finished(f.service);
  const saved = f.service.detail(original.id).application;
  assert.ok(saved);
  assert.equal(f.service.detail(original.id).job.status, 'failed');
  f.repository.unavailable = false;
  const retry = { requestId: randomUUID(), jobId: original.id };
  f.service.retry(retry);
  f.service.retry(retry);
  await finished(f.service);
  assert.equal(f.runtime.calls.length, 1);
  assert.equal(f.service.detail(original.id).job.retryCount, 1);
  assert.deepEqual(f.service.detail(original.id).application, saved);
  assert.equal(f.repository.applications.length, 1);
});

test('unavailable reasoning effort fails without replacing the chosen model or answer', async (t) => {
  const f = fixture(t),
    original = source();
  f.repository.sources.set(original.id, original);
  f.runtime.supported = false;
  f.service.setBaseUrl('http://127.0.0.1:12345');
  await finished(f.service);
  assert.equal(f.runtime.calls.length, 0);
  assert.equal(f.service.detail(original.id).job.status, 'failed');
  assert.deepEqual(f.service.detail(original.id).source, original);
});

test('restart recovers the commit gap using the same application and retains all pending jobs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-assessment-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'mini-ai.sqlite');
  const repository = new Repository(),
    original = source();
  repository.sources.set(original.id, original);
  let store = new MiniAssessmentStore(filename, now);
  store.ensure(original);
  const hash = miniAssessmentHash(original);
  const application: MiniAssessmentApplication = {
    requestId: original.id,
    source: original,
    result: result(original),
    trace: {
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
      threadId: 'thread-original',
      rulesVersion: 'mini-assessment-v1',
      skillHash: hash,
      promptHash: hash,
      inputHash: hash,
      startedAt: original.confirmedAt,
      assessedAt: original.confirmedAt + 1,
    },
  };
  store.saveApplication(application);
  store.status(original.id, 'running');
  repository.apply(application); // learning commit happened, AI receipt did not
  for (let index = 0; index < 55; index++) store.ensure(source());
  store.close();
  store = new MiniAssessmentStore(filename, now);
  assert.equal(store.snapshot().pendingCount, 55);
  assert.equal(store.snapshot().runningCount, 1);
  // Other queued tasks deliberately lack their source: they must not be sent to a model.
  for (const item of store.all().filter((item) => item.job.id !== original.id))
    store.status(item.job.id, 'failed', 'source unavailable');
  const runtime = new Runtime();
  const service = new MiniAssessmentService(repository, store, runtime, now);
  service.setBaseUrl('http://127.0.0.1:12345');
  await finished(service, 56);
  assert.equal(service.detail(original.id).job.status, 'completed');
  assert.equal(repository.applications.length, 1);
  assert.equal(runtime.calls.length, 0);
  const before = service.detail(original.id);
  await service.close();
  const reopened = new MiniAssessmentStore(filename, now);
  assert.deepEqual(reopened.detail(original.id), before);
  reopened.close();
});

test('clearing a learner conversation does not cancel confirmed assessment work', (t) => {
  const ai = new MiniAiStore(':memory:', now),
    assessment = new MiniAssessmentStore(':memory:', now);
  t.after(() => {
    ai.close();
    assessment.close();
  });
  const original = source();
  ai.importLegacy({
    requestId: randomUUID(),
    conversations: [{ id: 'bag', title: 'bag', word: original.word, messages: [] }],
  });
  assessment.ensure(original);
  ai.clear({ requestId: randomUUID(), conversationId: 'bag' });
  assert.equal(assessment.detail(original.id).job.status, 'queued');
  assert.deepEqual(assessment.detail(original.id).source.answer, original.answer);
});

test('same source or request identity cannot replace frozen evidence or a saved result', (t) => {
  const store = new MiniAssessmentStore(':memory:', now);
  t.after(() => store.close());
  const original = source();
  store.ensure(original);
  assert.throws(
    () => store.ensure({ ...original, answer: 'later correction' }),
    hasCode('ASSESSMENT_SOURCE_CHANGED'),
  );
  const hash = miniAssessmentHash(original);
  const application: MiniAssessmentApplication = {
    requestId: original.id,
    source: original,
    result: result(original),
    trace: {
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
      threadId: null,
      rulesVersion: 'mini-assessment-v1',
      skillHash: hash,
      promptHash: hash,
      inputHash: hash,
      startedAt: original.confirmedAt,
      assessedAt: original.confirmedAt,
    },
  };
  const requestId = randomUUID();
  store.saveApplication(application, requestId);
  assert.throws(
    () =>
      store.saveApplication(
        { ...application, result: { ...application.result, summary: 'replacement' } },
        requestId,
      ),
    hasCode('REQUEST_CONFLICT'),
  );
  assert.throws(
    () =>
      store.saveApplication(
        { ...application, result: { ...application.result, summary: 'replacement' } },
        randomUUID(),
      ),
    hasCode('ASSESSMENT_RESULT_CONFLICT'),
  );
});

test('the real stdio assessment MCP exposes only frozen-read and structured-assessment tools', async (t) => {
  const f = fixture(t),
    original = source();
  f.repository.sources.set(original.id, original);
  const app = buildApp({
    mini: { store: new MiniStore(':memory:'), token: 'a'.repeat(64), assessment: f.service },
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  f.runtime.behavior = async (options) => {
    const client = new Client({ name: 'assessment-test', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('./mini-assessment-mcp.ts', import.meta.url)),
      ],
      env: options.mcp.env,
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
        'learning_get_assessment',
        'learning_submit_assessment',
      ]);
      const context = await client.callTool({ name: 'learning_get_assessment', arguments: {} });
      assert.notEqual(context.isError, true);
      const requestId = randomUUID();
      const rejected = await client.callTool({
        name: 'learning_submit_assessment',
        arguments: {
          requestId,
          result: { ...result(original), uncertainties: ['近期曝光不能证明长期保持。'] },
        },
      });
      assert.equal(rejected.isError, true);
      assert.match(JSON.stringify(rejected.content), /ASSESSMENT_UNCERTAINTY_SCOPE/);
      assert.equal(
        f.service.detail(original.id).application,
        null,
        'contradictory certainty does not persist or adopt',
      );
      const saved = await client.callTool({
        name: 'learning_submit_assessment',
        arguments: { requestId, result: result(original) },
      });
      assert.notEqual(saved.isError, true);
    } finally {
      await client.close();
      await transport.close();
    }
  };
  f.service.setBaseUrl(url);
  await finished(f.service);
  assert.equal(f.service.detail(original.id).job.status, 'completed');
  assert.equal(f.repository.applications.length, 1);
});

test('real semantic uncertainty remains saveable and is never coerced into a definite judgment', async (t) => {
  const f = fixture(t),
    original = source();
  f.repository.sources.set(original.id, original);
  f.runtime.behavior = async (options) => {
    const uncertain = result(original);
    uncertain.meaning = {
      outcome: 'uncertain',
      explanation: '题目中的指代有两种可能，无法确定目标意义。',
      evidenceIds: [original.question.id],
    };
    uncertain.uncertainties = ['目标意义所需的指代上下文缺失。'];
    f.submit(options, uncertain);
  };
  f.service.setBaseUrl('http://127.0.0.1:12345');
  await finished(f.service);
  assert.equal(f.service.detail(original.id).application?.result.meaning.outcome, 'uncertain');
  assert.deepEqual(f.service.detail(original.id).application?.result.uncertainties, [
    '目标意义所需的指代上下文缺失。',
  ]);
});

test('assessment HTTP enforces mini authorization and origin boundaries for status, detail and retry', async (t) => {
  const repository = new Repository(),
    runtime = new Runtime();
  const assessment = new MiniAssessmentService(
    repository,
    new MiniAssessmentStore(':memory:'),
    runtime,
  );
  const study = new MiniStore(':memory:');
  const token = 'b'.repeat(64),
    authorization = `Bearer ${token}`;
  const app = buildApp({ mini: { store: study, token, assessment } });
  t.after(() => app.close());
  const original = source();
  assessment.store.ensure(original);
  assessment.store.status(original.id, 'failed', '保存的失败');
  for (const [method, url, payload] of [
    ['GET', '/api/mini/assessments/snapshot', undefined],
    ['GET', `/api/mini/assessments/${original.id}`, undefined],
    ['POST', '/api/mini/assessments/retry', { requestId: randomUUID(), jobId: original.id }],
  ] as const) {
    const request = { method, url, ...(payload ? { payload } : {}) };
    assert.equal((await app.inject(request)).statusCode, 401);
    assert.equal(
      (await app.inject({ ...request, headers: { authorization, origin: 'http://localhost:1' } }))
        .statusCode,
      403,
    );
    assert.equal((await app.inject({ ...request, headers: { authorization } })).statusCode, 200);
  }
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/api/mini/assessments/not-a-uuid',
        headers: { authorization },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: `/api/mini/assessments/${randomUUID()}`,
        headers: { authorization },
      })
    ).statusCode,
    404,
  );
  const internal = {
    method: 'POST' as const,
    url: `/api/internal/mini-assessment/${original.id}`,
    payload: { action: 'context' },
  };
  assert.equal((await app.inject({ ...internal, headers: { authorization } })).statusCode, 403);
  assert.equal(
    (await app.inject({ ...internal, headers: { authorization, origin: 'http://localhost:1' } }))
      .statusCode,
    403,
  );
  assert.equal(
    study.snapshot().revision,
    0,
    'inspection and retries do not fabricate learner facts',
  );
});

test('real learning Next freezes an outbox, advances immediately and adopts a background result exactly once across reopen', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-assessment-flow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const learningFile = join(directory, 'mini.sqlite'),
    aiFile = join(directory, 'mini-ai.sqlite');
  let time = new Date('2026-11-17T06:00:00Z').getTime();
  const clock = () => new Date(time);
  const study = new MiniStore(learningFile, { now: clock, timezone: 'Asia/Shanghai' });
  const tasks = new MiniAssessmentStore(aiFile, clock);
  const chat = new MiniAiStore(aiFile, clock);
  chat.importLegacy({ requestId: randomUUID(), conversations: [] });
  study.setAssessmentDiscussionProvider((word, submittedAt, confirmedAt) =>
    chat.discussionForAssessment(word, submittedAt, confirmedAt),
  );
  const runtime = new Runtime();
  const service = new MiniAssessmentService(
    {
      pending: () => study.pendingAssessments(),
      get: (id) => study.assessmentSource(id),
      apply: (application) => study.applyAssessment(application),
    },
    tasks,
    runtime,
    clock,
  );
  const token = 'c'.repeat(64),
    authorization = `Bearer ${token}`;
  const app = buildApp({ mini: { store: study, token, assessment: service } });
  t.after(() => app.close());
  t.after(() => chat.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  service.setBaseUrl(address);
  const act = (action: MiniAction) => {
    time += 1000;
    return study.command({
      requestId: randomUUID(),
      expectedRevision: study.snapshot().revision,
      action,
    });
  };
  study.importLegacy({
    requestId: randomUUID(),
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
    timezone: 'Asia/Shanghai',
  });
  act({
    type: 'set_long_term_plan',
    target: 'daily',
    plan: {
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      wordLimit: 10,
      newWordLimit: 5,

      dailyNewGoal: 1,
      groupSize: 1,
    },
  });
  const word = { spelling: 'bag', meaning: '包', phonetic: '' };
  act({
    type: 'begin',
    target: 'daily',
    deck: [word],
    timezone: 'Asia/Shanghai',
    flowVersion: 'sliding-window-v2',
  });
  const day = () => {
    const value = study.snapshot().ledger.days.at(-1);
    assert.ok(value);
    return value;
  };
  const target = { target: 'daily' as const, dayId: day().id };
  act({
    ...target,
    type: 'add_sentences',
    sentences: miniPreparationWords(day()).map((word) => ({
      word,
      english: 'I have a bag.',
      chinese: '我有一个包。',
    })),
  });
  for (let index = 0; index < 10; index++) {
    const visit = currentMiniWindow(day())?.visit;
    if (!visit) break;
    const windowTarget = {
      ...target,
      session: 'learning' as const,
      word: visit.word,
      visitId: visit.id,
    };
    if (visit.stage > 0) act({ ...windowTarget, type: 'window_choose', remembered: true });
    act({
      ...windowTarget,
      type: 'window_advance',
      ...(visit.stage === 0 ? { remembered: true } : {}),
    });
  }
  assert.equal(day().learning?.phase, 'spelling');
  time += 360_000;
  act({
    ...target,
    type: 'submit_spelling',
    session: 'learning',
    word,
    answer: 'bga',
    advanceOnCorrect: false,
  });
  act({
    ...target,
    type: 'submit_spelling',
    session: 'learning',
    word,
    answer: 'bag',
    advanceOnCorrect: false,
  });
  act({ ...target, type: 'advance_spelling', session: 'learning', word });
  act({
    ...target,
    type: 'submit_spelling',
    session: 'learning',
    word,
    answer: 'bag',
    advanceOnCorrect: false,
  });
  act({ ...target, type: 'advance_spelling', session: 'learning', word });
  act({
    ...target,
    type: 'publish_writing',
    prompts: miniWritingWords(day()).map((word, index) => ({
      id: randomUUID(),
      sentence: { word, english: 'My bag is blue.', chinese: '我的包是蓝色的。' },
      direction: day().directions[index] ?? 'englishToChinese',
      focusIds: [],
    })),
  });
  act({ ...target, type: 'complete_learning' });
  const task = currentTranslation(day());
  assert.ok(task);
  act({ ...target, type: 'submit_translation', taskId: task.id, answer: '这是我蓝色的包。' });
  const attempt = day().translation.at(-1);
  assert.ok(attempt);
  assert.equal(study.pendingAssessments().length, 0);
  const legacy = new MiniStore(':memory:', { now: clock, timezone: 'Asia/Shanghai' });
  try {
    legacy.importLegacy({
      requestId: randomUUID(),
      ledger: study.snapshot().ledger,
      reviewRecord: null,
      reviewHistory: [],
      timezone: 'Asia/Shanghai',
    });
    legacy.command({
      requestId: randomUUID(),
      expectedRevision: legacy.snapshot().revision,
      action: { ...target, type: 'advance_translation', taskId: task.id },
    });
    const recovered = legacy.assessmentSource(attempt.id);
    assert.ok(recovered);
    assert.equal(
      recovered.learningEvidence.capturedAtSubmission,
      false,
      'old pending answers cannot reconstruct independent evidence from newer projections',
    );
    assert.deepEqual(
      recovered.learningEvidence.eligibility &&
        typeof recovered.learningEvidence.eligibility === 'object' &&
        !Array.isArray(recovered.learningEvidence.eligibility)
        ? recovered.learningEvidence.eligibility.meaning
        : undefined,
      false,
    );
  } finally {
    legacy.close();
  }
  act({
    ...target,
    type: 'record_exposure',
    word,
    kind: 'potentialHelp',
    source: 'chat',
    focusIds: [],
    sourceMessageId: randomUUID(),
  });
  time += 1000;
  chat.start({
    requestId: randomUUID(),
    kind: 'advisor',
    timezone: 'Asia/Shanghai',
    conversationId: 'bag',
    word,
    message: '这个句子还能怎么说？',
    model: 'gpt-6.1-sol',
    effort: 'xhigh',
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  runtime.behavior = async (options) => {
    options.signal?.addEventListener('abort', release, { once: true });
    await gate;
    if (options.signal?.aborted) return;
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${options.mcp.env.LINGOWEAVE_MINI_ASSESSMENT_TOKEN}`,
    };
    const url = options.mcp.env.LINGOWEAVE_MINI_ASSESSMENT_URL;
    assert.ok(url);
    const context = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'context' }),
    });
    assert.equal(context.status, 200);
    const source = study.assessmentSource(attempt.id);
    assert.ok(source);
    const evaluated = result(source);
    evaluated.spelling = {
      outcome: 'not_tested',
      explanation: '英译中没有测试英文拼写。',
      evidenceIds: [source.attemptId],
    };
    const committed = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action: 'commit',
        input: { requestId: randomUUID(), result: evaluated },
      }),
    });
    assert.equal(committed.status, 200, await committed.text());
  };
  time += 1000;
  const next = {
    requestId: randomUUID(),
    expectedRevision: study.snapshot().revision,
    action: { ...target, type: 'advance_translation', taskId: task.id },
  };
  const response = await app.inject({
    method: 'POST',
    url: '/api/mini/commands',
    headers: { authorization },
    payload: next,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(
    day().flow?.completed.length,
    1,
    'learner finishes without waiting for background inference',
  );
  const source = study.assessmentSource(attempt.id);
  assert.ok(source);
  assert.equal(source.answer, '这是我蓝色的包。');
  assert.equal(source.learningEvidence.capturedAtSubmission, true);
  assert.deepEqual(
    source.learningEvidence.exposures,
    [],
    'post-answer help is not inserted into the immutable pre-answer evidence',
  );
  const qualification = source.learningEvidence.eligibility;
  assert.ok(qualification && typeof qualification === 'object' && !Array.isArray(qualification));
  assert.equal(
    qualification.meaning,
    false,
    'old memory timing cannot hide an immediately preceding spelling correction/green confirmation',
  );
  assert.equal(qualification.spelling, false);
  assert.equal(source.discussion[0]?.relation, 'after_answer');
  assert.equal(study.pendingAssessments().length, 1);
  assert.equal(service.snapshot().runningCount + service.snapshot().pendingCount, 1);
  chat.clear({ requestId: randomUUID(), conversationId: 'bag' });
  assert.deepEqual(
    study.assessmentSource(attempt.id),
    source,
    'clearing a chat cannot remove the confirmed assessment evidence',
  );
  release();
  await finished(service);
  assert.equal(service.detail(attempt.id).job.status, 'completed');
  assert.equal(study.pendingAssessments().length, 0);
  const adopted = study
    .snapshot()
    .scheduling.flow.events.find((event) => event.kind === 'assessment');
  assert.equal(adopted?.meaning, null, 'a supported translation cannot add an independent Good');
  assert.equal(adopted?.spelling, null);
  const committed = study.snapshot();
  const application = service.detail(attempt.id).application;
  assert.ok(application);
  study.applyAssessment(application);
  assert.deepEqual(
    study.snapshot(),
    committed,
    'replayed adoption has no second learning or scheduling effect',
  );
  assert.equal(committed.ledger.days.at(-1)?.flow?.completed.length, 1);
  const detail = service.detail(attempt.id);
  await app.close();
  const reopenedStudy = new MiniStore(learningFile),
    reopenedTasks = new MiniAssessmentStore(aiFile);
  try {
    assert.deepEqual(reopenedStudy.snapshot(), committed);
    assert.deepEqual(reopenedTasks.detail(attempt.id), detail);
  } finally {
    reopenedStudy.close();
    reopenedTasks.close();
  }
});
