import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import {
  miniAiStartSchema,
  miniCommandSchema,
  type MiniAction,
  type MiniAiStart,
  type MiniCommand,
  type MiniWord,
  type RuntimeStatus,
} from '@lingoweave/contracts';
import { LearningError } from './learning-store.js';
import { CodexError } from './codex/transport.js';
import { buildApp } from './app.js';
import { MiniAiService } from './mini-ai-service.js';
import { MiniAiStore } from './mini-ai-store.js';
import { miniAiActionOptions } from './mini-ai-policy.js';
import { MiniStore } from './mini-store.js';
import {
  currentMiniWindow,
  currentTranslation,
  miniPreparationWords,
  miniWritingWords,
} from './mini-study.js';
import type { PreparationRuntime } from './preparation-service.js';

const timezone = 'Asia/Shanghai';
const now = () => new Date('2026-11-13T04:00:00Z');
const apple: MiniWord = { spelling: 'apple', meaning: '苹果', phonetic: '' };
const book: MiniWord = { spelling: 'book', meaning: '书', phonetic: '' };
const example = (word: MiniWord) => ({
  word,
  english: `I see ${word.spelling}.`,
  chinese: `我看见${word.meaning}。`,
});
const hasCode = (code: string) => (error: unknown) =>
  error instanceof LearningError && error.code === code;
const contextSchema = z.object({
  revision: z.number().int().nonnegative(),
  allowedActions: z.array(z.string()),
  sourceMessageId: z.uuid().nullable(),
});
type RuntimeOptions = Parameters<PreparationRuntime['prepare']>[0];
class FakeRuntime implements PreparationRuntime {
  readonly calls: RuntimeOptions[] = [];
  behavior: (options: RuntimeOptions) => Promise<void> = async () => {};
  async status(): Promise<RuntimeStatus> {
    return {
      available: true,
      authenticated: true,
      version: 'test',
      models: [
        { id: 'gpt-6.1-sol', name: 'test', isDefault: true, supportedReasoningEfforts: ['xhigh'] },
      ],
      error: null,
    };
  }
  async prepare(options: RuntimeOptions) {
    this.calls.push(options);
    await this.behavior(options);
    return { threadId: `thread-${options.jobId}`, model: 'gpt-6.1-sol' };
  }
  async close() {}
}
function startInput(input: Partial<MiniAiStart> = {}): MiniAiStart {
  return miniAiStartSchema.parse({
    requestId: randomUUID(),
    kind: 'advisor',
    timezone,
    message: '今天少学一点。',
    ...input,
  });
}
function initialize(study: MiniStore) {
  study.importLegacy({
    requestId: randomUUID(),
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
    timezone,
  });
}
function fixture(t: TestContext, deck: MiniWord[] = [apple], clock = now) {
  const study = new MiniStore(':memory:', { now: clock, timezone });
  initialize(study);
  const ai = new MiniAiStore(':memory:', clock);
  ai.importLegacy({ requestId: randomUUID(), conversations: [] });
  const runtime = new FakeRuntime();
  const service = new MiniAiService(study, ai, runtime, undefined, undefined, undefined, 5);
  service.setBaseUrl('http://127.0.0.1:12345');
  t.after(async () => {
    await service.close();
    study.close();
  });
  const act = (action: z.input<typeof miniCommandSchema>['action']) =>
    study.command(
      miniCommandSchema.parse({
        requestId: randomUUID(),
        expectedRevision: study.snapshot().revision,
        action,
      }),
    );
  const day = () => {
    const value = study.snapshot().ledger.days.at(-1);
    assert.ok(value);
    return value;
  };
  const begin = () => act({ type: 'begin', target: 'daily', deck, timezone });
  const tool = (options: RuntimeOptions, action: string, input: unknown = {}) => {
    const token = options.mcp.env.LINGOWEAVE_MINI_AI_TOKEN;
    assert.ok(token);
    return service.tool(options.jobId, token, action, input);
  };
  const read = (options: RuntimeOptions) => contextSchema.parse(tool(options, 'context'));
  const commit = (options: RuntimeOptions, action: MiniAction, requestId = randomUUID()) => {
    const context = read(options);
    return tool(options, 'commit', { requestId, expectedRevision: context.revision, action });
  };
  return { study, ai, runtime, service, act, day, begin, tool, read, commit };
}
type Fixture = ReturnType<typeof fixture>;
async function settled(data: Fixture, id: string) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const job = data.ai.job(id);
    if (!['queued', 'running'].includes(job.status)) {
      await setImmediate();
      return data.ai.job(id);
    }
    await setImmediate();
  }
  assert.fail(`AI task ${id} did not settle`);
}
function prepareWriting(data: Fixture) {
  const dayId = data.day().id;
  data.act({
    type: 'add_sentences',
    target: 'daily',
    dayId,
    sentences: data.day().learningWords.map(example),
  });
  for (const word of data.day().learningWords)
    data.act({ type: 'mark_studied', target: 'daily', dayId, word });
  for (const word of data.day().learning?.queue ?? [])
    data.act({
      type: 'submit_spelling',
      target: 'daily',
      dayId,
      session: 'learning',
      word,
      answer: word.spelling,
    });
  data.act({ type: 'complete_learning', target: 'daily', dayId });
  const direction = data.day().directions[0];
  assert.ok(direction);
  data.act({
    type: 'publish_writing',
    target: 'daily',
    dayId,
    prompts: [
      {
        id: randomUUID(),
        sentence: {
          word: apple,
          english: 'We need an apple today.',
          chinese: '我们今天需要一个苹果。',
        },
        direction,
        focusIds: [],
      },
    ],
  });
  const task = currentTranslation(data.day());
  assert.ok(task);
  data.act({
    type: 'submit_translation',
    target: 'daily',
    dayId,
    taskId: task.id,
    answer: '我们今天需要一个苹果。',
  });
  const attempt = data.day().translation.at(-1);
  assert.ok(attempt);
  return attempt;
}

test('AI chat import preserves original messages and replays without publishing duplicates', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-mini-ai-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'ai.sqlite');
  let store = new MiniAiStore(filename, now);
  t.after(() => store.close());
  const input = {
    requestId: randomUUID(),
    conversations: [
      {
        id: 'advisor',
        title: '旧聊天',
        word: null,
        messages: [
          { id: randomUUID(), role: 'user' as const, text: '只在工作日学习。' },
          { id: randomUUID(), role: 'assistant' as const, text: '已收到。' },
        ],
      },
    ],
  };
  store.importLegacy(input);
  store.importLegacy(input);
  assert.equal(store.snapshot().conversations.length, 1);
  assert.deepEqual(
    store
      .messages('advisor')
      .map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt })),
    input.conversations[0]?.messages.map((message) => ({ ...message, createdAt: null })),
  );
  assert.throws(
    () => store.importLegacy({ ...input, conversations: [] }),
    hasCode('REQUEST_CONFLICT'),
  );
  assert.throws(
    () => store.importLegacy({ ...input, requestId: randomUUID() }),
    hasCode('AI_ALREADY_IMPORTED'),
  );
  const before = store.snapshot();
  store.close();
  store = new MiniAiStore(filename, now);
  assert.deepEqual(store.snapshot(), before);
});

test('failed advisor retries retain the original user message and publish the final reply once', async (t) => {
  const data = fixture(t);
  let runs = 0;
  data.runtime.behavior = async (options) => {
    runs += 1;
    options.onText(runs === 1 ? '未完成的回复' : '完整回复');
    if (runs === 1) throw new Error('lost connection');
  };
  const input = startInput({ message: '今天只学一个词。' });
  const first = data.service.start(input);
  assert.equal((await settled(data, first.id)).status, 'failed');
  assert.equal(data.ai.userMessage(first.id)?.text, input.message);
  data.service.retry({ requestId: randomUUID(), jobId: first.id });
  assert.equal((await settled(data, first.id)).status, 'completed');
  const messages = data.ai.messages(input.conversationId);
  assert.equal(messages.filter((message) => message.role === 'user').length, 1);
  assert.deepEqual(
    messages.filter((message) => message.role === 'assistant').map((message) => message.text),
    ['完整回复'],
  );
  assert.equal(data.runtime.calls.length, 2);
});

function practiceStartFrame(study: MiniStore) {
  study.practicePattern({
    requestId: randomUUID(),
    timezone,
    batchId: study.patterns(timezone).batchId,
    patternId: 'a1-need',
    answer: 'I need a pen.',
    usedHint: false,
  });
}

test('English scene starts without inventing a learner message, reads only practiced content, and closes on actual dialogue reflection', async (t) => {
  const data = fixture(t, [apple, book]);
  const conversationId = `dialogue:${randomUUID()}`;
  const open = startInput({ kind: 'dialogue', conversationId, message: undefined });
  assert.throws(() => data.service.start(open), hasCode('DIALOGUE_NOT_READY'));
  data.begin();
  const dayId = data.day().id;
  data.act({
    type: 'add_sentences',
    target: 'daily',
    dayId,
    sentences: [example(apple), example(book)],
  });
  data.act({ type: 'mark_studied', target: 'daily', dayId, word: apple });
  practiceStartFrame(data.study);
  const before = data.study.snapshot();
  const practicedBefore = data.study.patternContext();
  const schema = z
    .object({
      mode: z.enum(['open', 'reply', 'reflect']),
      allowedActions: z.array(z.string()),
      practicedPatterns: z.array(z.object({ id: z.string() })),
      encounteredWords: z.array(z.object({ spelling: z.string() })),
      messages: z.array(z.object({ role: z.string(), text: z.string() })),
    })
    .strict();
  const seen: z.infer<typeof schema>[] = [];
  data.runtime.behavior = async (options) => {
    assert.deepEqual(options.tools, ['learning_get_context']);
    assert.equal(options.skill?.name, 'mini-dialogue');
    for (const action of ['history', 'word', 'audio_request', 'commit'])
      assert.throws(() => data.tool(options, action), hasCode('AI_ACTION_FORBIDDEN'));
    const c = schema.parse(data.tool(options, 'context'));
    seen.push(c);
    assert.deepEqual(c.allowedActions, []);
    assert.deepEqual(
      c.practicedPatterns.map((p) => p.id),
      ['a1-need'],
    );
    assert.deepEqual(
      c.encounteredWords.map((w) => w.spelling),
      ['apple'],
    );
    options.onText(
      c.mode === 'open'
        ? 'Hello! Can I help you?'
        : c.mode === 'reply'
          ? 'Here you are.'
          : 'You asked clearly for a pen.',
    );
  };
  const run = async (input: MiniAiStart) => {
    const job = data.service.start(input);
    assert.equal((await settled(data, job.id)).status, 'completed');
    return job;
  };
  const other = startInput({
    kind: 'dialogue',
    conversationId: `dialogue:${randomUUID()}`,
    message: 'A bag.',
  });
  assert.throws(() => data.service.start(other), hasCode('DIALOGUE_NOT_OPEN'));
  const opening = await run(open);
  assert.equal(data.service.start(open).id, opening.id);
  assert.throws(
    () => data.service.start({ ...open, requestId: randomUUID() }),
    hasCode('DIALOGUE_EXISTS'),
  );
  assert.equal(data.ai.userMessage(opening.id), undefined);
  assert.equal(
    miniAiStartSchema.safeParse({ ...open, kind: 'advisor', message: 'hi' }).success,
    false,
  );
  assert.equal(miniAiStartSchema.safeParse({ ...open, conversationId: 'advisor' }).success, false);
  const reflect = { ...open, requestId: randomUUID(), dialogueStep: 'reflect' as const };
  assert.throws(() => data.service.start(reflect), hasCode('DIALOGUE_NO_REPLY'));
  const reply = { ...open, requestId: randomUUID(), message: 'I need a pen.' };
  await run(reply);
  const end = await run(reflect);
  assert.equal(end.dialogueStep, 'reflect');
  assert.throws(
    () => data.service.start({ ...reply, requestId: randomUUID() }),
    hasCode('DIALOGUE_NOT_OPEN'),
  );
  assert.deepEqual(
    seen.map((c) => c.mode),
    ['open', 'reply', 'reflect'],
  );
  assert.deepEqual(
    seen.map((c) => c.messages.map((m) => m.role)),
    [[], ['assistant', 'user'], ['assistant', 'user', 'assistant']],
  );
  assert.deepEqual(
    data.ai.messages(conversationId).map((m) => m.role),
    ['assistant', 'user', 'assistant', 'assistant'],
  );
  assert.deepEqual(data.study.snapshot(), before);
  assert.deepEqual(data.study.patternContext(), practicedBefore);
});

test('unread or non-English model output never appears as an English scene turn; retry preserves identity', async (t) => {
  const data = fixture(t);
  practiceStartFrame(data.study);
  const conversationId = `dialogue:${randomUUID()}`;
  const input = startInput({ kind: 'dialogue', conversationId, message: undefined });
  data.runtime.behavior = async (options) => {
    options.onText('Hello.');
  };
  const job = data.service.start(input);
  assert.equal((await settled(data, job.id)).status, 'failed');
  data.runtime.behavior = async (options) => {
    data.tool(options, 'context');
    options.onText('你好');
  };
  data.service.retry({ requestId: randomUUID(), jobId: job.id });
  assert.equal((await settled(data, job.id)).text, '');
  assert.deepEqual(data.ai.messages(conversationId), []);
  data.runtime.behavior = async (options) => {
    data.tool(options, 'context');
    options.onText('Hello!');
  };
  data.service.retry({ requestId: randomUUID(), jobId: job.id });
  assert.equal((await settled(data, job.id)).status, 'completed');
  assert.deepEqual(
    data.ai.messages(conversationId).map((m) => m.text),
    ['Hello!'],
  );
});

test('preparation and independent writing may reuse practiced frames but never expose the untouched catalog', async (t) => {
  const data = fixture(t);
  data.begin();
  practiceStartFrame(data.study);
  const readCurriculum = z.object({
    curriculum: z.object({
      practicedPatterns: z.array(z.object({ id: z.string() })),
      patternGuidance: z.string(),
    }),
  });
  for (const kind of ['prepare', 'writing'] as const) {
    let checked = false;
    data.runtime.behavior = async (options) => {
      const { curriculum } = readCurriculum.parse(data.tool(options, 'context'));
      assert.deepEqual(
        curriculum.practicedPatterns.map((p) => p.id),
        ['a1-need'],
      );
      assert.match(curriculum.patternGuidance, /No quota/);
      checked = true;
    };
    const job = data.service.start(startInput({ kind, dayId: data.day().id, message: undefined }));
    await settled(data, job.id);
    assert.ok(checked);
  }
});

test('long scene context keeps the opening and recent actual messages; a different scene sees none of them', (t) => {
  const store = new MiniAiStore(':memory:', now);
  t.after(() => store.close());
  store.importLegacy({ requestId: randomUUID(), conversations: [] });
  const scene = `dialogue:${randomUUID()}`;
  for (let n = 0; n < 10; n++) {
    const { job } = store.start(
      startInput({
        kind: 'dialogue',
        conversationId: scene,
        message: n ? `Reply ${n}` : undefined,
      }),
    );
    store.update(job.id, (job) => {
      job.text = n ? `Turn ${n}` : 'Welcome to the shop.';
    });
    store.finish(job.id, 'completed');
  }
  const messages = store.messages(scene);
  assert.equal(messages.length, 12);
  assert.equal(messages[0]?.text, 'Welcome to the shop.');
  assert.equal(messages.at(-2)?.text, 'Reply 9');
  assert.equal(messages.at(-1)?.text, 'Turn 9');
  assert.deepEqual(store.messages(`dialogue:${randomUUID()}`), []);
});

test('chat retries preserve one actual support exposure without blocking the final reply', async (t) => {
  const data = fixture(t);
  data.begin();
  let runs = 0;
  data.runtime.behavior = async (options) => {
    runs += 1;
    options.onText(runs === 1 ? '先看这个词' : '重试后的完整讲解');
    if (runs === 1) throw new Error('runtime stopped after showing help');
  };
  const job = data.service.start(startInput({ word: apple, message: '解释一下 apple。' }));
  assert.equal((await settled(data, job.id)).status, 'failed');
  const first = data.study.snapshot();
  assert.equal(first.teaching.exposures.length, 1);
  data.service.retry({ requestId: randomUUID(), jobId: job.id });
  assert.equal((await settled(data, job.id)).status, 'completed');
  assert.equal(data.study.snapshot().teaching.exposures.length, 1);
  assert.equal(data.ai.job(job.id).text, '重试后的完整讲解');
  assert.deepEqual(data.day().studiedWords, []);
});

test('chat on an earlier translation reads that answer and records help against its word', async (t) => {
  const data = fixture(t, [apple, book]);
  data.begin();
  const first = prepareWriting(data);
  const dayId = data.day().id;
  data.act({
    type: 'record_feedback',
    target: 'daily',
    dayId,
    attemptId: first.id,
    feedback: { comment: '意思清楚。', tip: '', usefulPhrase: '' },
  });
  data.act({ type: 'advance_translation', target: 'daily', dayId, taskId: first.task.id });
  assert.equal(data.day().translationIndex, 1);
  data.runtime.behavior = async (options) => {
    const context = z
      .object({
        currentTask: z.object({ id: z.string() }),
        day: z.object({ attempt: z.object({ id: z.uuid(), answer: z.string() }) }),
      })
      .parse(data.tool(options, 'context'));
    assert.equal(context.currentTask.id, first.task.id);
    assert.equal(context.day.attempt.answer, first.answer);
    options.onText('可以一起看看上一句的意思。');
  };
  const job = data.service.start(
    startInput({ dayId, word: apple, attemptId: first.id, message: '再看看这句。' }),
  );
  assert.equal((await settled(data, job.id)).status, 'completed');
  const exposure = data.study.snapshot().teaching.exposures.at(-1);
  assert.equal(exposure?.source, 'chat');
  assert.equal(exposure?.taskId, first.task.id);
  assert.deepEqual(exposure?.word, apple);
});

test('advisor text records actual support for the current standalone legacy review card', async (t) => {
  const data = fixture(t);
  data.act({ type: 'begin', target: 'review', deck: [apple], timezone });
  const record = data.study.snapshot().reviewRecord;
  assert.ok(record);
  data.runtime.behavior = async (options) => options.onText('apple 的意思是苹果。');
  const job = data.service.start(startInput({ word: apple, message: '解释 apple。' }));
  assert.equal((await settled(data, job.id)).status, 'completed');
  const exposures = data.study.snapshot().teaching.exposures;
  assert.equal(exposures.length, 1);
  assert.deepEqual(
    exposures.map((item) => ({
      target: item.target,
      recordId: item.recordId,
      session: item.session,
      word: item.word,
      kind: item.kind,
      source: item.source,
    })),
    [
      {
        target: 'review',
        recordId: record.id,
        session: 'review',
        word: apple,
        kind: 'potentialHelp',
        source: 'chat',
      },
    ],
  );
  assert.deepEqual(data.study.snapshot().reviewRecord?.session.judgmentEvents, []);
  assert.deepEqual(data.study.snapshot().reviewRecord?.session.spellingAttempts, []);
});

test('one streaming advisor job records the same word separately after the user changes review groups', async (t) => {
  const data = fixture(t);
  data.act({ type: 'begin', target: 'review', deck: [apple], timezone });
  const firstRecord = data.study.snapshot().reviewRecord;
  assert.ok(firstRecord);
  let ready = () => {};
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let release = () => {};
  data.runtime.behavior = async (options) => {
    options.onText('第一组的讲解。');
    ready();
    await new Promise<void>((resolve) => {
      release = resolve;
      options.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    options.onText('第二组的讲解。');
  };
  const job = data.service.start(startInput({ word: apple, message: '解释一下。' }));
  await started;
  const context = { target: 'review' as const, recordId: firstRecord.id };
  data.act({ ...context, type: 'choose_judgment', word: apple, judgment: 'clear' });
  data.act({ ...context, type: 'advance_judgment', word: apple });
  for (let count = 0; count < 5; count += 1) {
    if (data.study.snapshot().reviewRecord?.session.phase === 'finished') break;
    data.act({ ...context, type: 'submit_spelling', word: apple, answer: apple.spelling });
  }
  assert.equal(data.study.snapshot().reviewRecord?.session.phase, 'finished');
  data.act({ type: 'begin', target: 'review', deck: [apple], timezone });
  const secondRecord = data.study.snapshot().reviewRecord;
  assert.ok(secondRecord);
  assert.notEqual(secondRecord.id, firstRecord.id);
  release();
  assert.equal((await settled(data, job.id)).status, 'completed');
  const exposures = data.study.snapshot().teaching.exposures;
  assert.deepEqual(
    exposures.map((item) => item.recordId),
    [firstRecord.id, secondRecord.id],
  );
  assert.ok(exposures.every((item) => item.target === 'review' && item.word.spelling === 'apple'));
  assert.deepEqual(data.study.snapshot().reviewRecord?.session.judgmentEvents, []);
});

test('opening a different known word conversation does not misattribute help or block its reply', async (t) => {
  const data = fixture(t, [apple, book]);
  data.begin();
  data.runtime.behavior = async (options) => options.onText('book 可以表示书。');
  const job = data.service.start(startInput({ word: book, message: 'book 是什么意思？' }));
  assert.equal((await settled(data, job.id)).status, 'completed');
  assert.equal(data.ai.job(job.id).text, 'book 可以表示书。');
  assert.equal(
    data.study.snapshot().teaching.exposures.some((exposure) => exposure.word.spelling === 'book'),
    false,
  );
  assert.deepEqual(data.day().studiedWords, []);
});

test('clearing a running conversation rejects late tools, late text and old-task retries', async (t) => {
  const data = fixture(t);
  let ready = () => {};
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let options: RuntimeOptions | undefined;
  data.runtime.behavior = async (current) => {
    options = current;
    current.onText('清除之前的文本');
    ready();
    await new Promise<void>((resolve) =>
      current.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    current.onText('清除后的迟到文本');
    current.onProgress('迟到进度');
  };
  const input = startInput();
  const job = data.service.start(input);
  await started;
  data.service.clear({ requestId: randomUUID(), conversationId: input.conversationId });
  await setImmediate();
  assert.ok(options);
  const expiredOptions = options;
  assert.throws(() => data.tool(expiredOptions, 'context'), hasCode('AI_TASK_EXPIRED'));
  assert.equal(data.ai.job(job.id).status, 'cancelled');
  assert.equal(data.ai.job(job.id).text, '');
  assert.deepEqual(data.ai.messages(input.conversationId), []);
  assert.throws(
    () => data.service.retry({ requestId: randomUUID(), jobId: job.id }),
    (error) => error instanceof LearningError,
  );
  data.runtime.behavior = async (current) => current.onText('新的会话');
  const next = data.service.start(
    startInput({ conversationId: input.conversationId, message: '从这里重新开始。' }),
  );
  assert.equal((await settled(data, next.id)).status, 'completed');
  assert.deepEqual(
    data.ai.messages(input.conversationId).map((message) => message.text),
    ['从这里重新开始。', '新的会话'],
  );
});

test('replaying a previous clear cannot abort a new message in the same conversation', async (t) => {
  const data = fixture(t);
  const clear = { requestId: randomUUID(), conversationId: 'advisor' };
  data.service.clear(clear);
  let ready = () => {};
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let release = () => {};
  data.runtime.behavior = async (options) => {
    ready();
    await new Promise<void>((resolve) => {
      release = resolve;
      options.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    options.onText('这条新消息应该能完成。');
  };
  const job = data.service.start(startInput());
  await started;
  data.service.clear(clear);
  const options = data.runtime.calls.at(-1);
  assert.ok(options);
  assert.equal(options.signal.aborted, false);
  release();
  assert.equal((await settled(data, job.id)).status, 'completed');
  assert.equal(data.ai.messages('advisor').length, 2);
});

test('replaying an earlier cancel cannot abort a new retry of the same task', async (t) => {
  const data = fixture(t);
  let ready = () => {};
  let started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let release = () => {};
  data.runtime.behavior = async (options) => {
    ready();
    await new Promise<void>((resolve) => {
      release = resolve;
      options.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    options.onText('重试后的回复。');
  };
  const job = data.service.start(startInput());
  await started;
  const cancel = { requestId: randomUUID(), jobId: job.id };
  data.service.cancel(cancel);
  await setImmediate();
  started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  data.service.retry({ requestId: randomUUID(), jobId: job.id });
  await started;
  data.service.cancel(cancel);
  const options = data.runtime.calls.at(-1);
  assert.ok(options);
  assert.equal(options.signal.aborted, false);
  release();
  assert.equal((await settled(data, job.id)).status, 'completed');
});

test('preparation executes context and real commits, with stable retries and no duplicate publication', async (t) => {
  const data = fixture(t);
  data.begin();
  const dayId = data.day().id;
  data.runtime.behavior = async (options) => {
    const context = data.read(options);
    assert.ok(context.allowedActions.includes('add_sentences'));
    const command: MiniCommand = {
      requestId: randomUUID(),
      expectedRevision: context.revision,
      action: { type: 'add_sentences', target: 'daily', dayId, sentences: [example(apple)] },
    };
    const receipt = data.tool(options, 'commit', command);
    assert.deepEqual(data.tool(options, 'commit', command), receipt);
    options.onText('例句已经准备好。');
  };
  const input = startInput({ kind: 'prepare', dayId, message: undefined });
  const job = data.service.start(input);
  assert.equal(data.service.start(input).id, job.id);
  assert.equal((await settled(data, job.id)).status, 'completed');
  assert.equal(data.day().sentences.length, 1);
  assert.equal(data.ai.job(job.id).receipts.length, 1);
  assert.equal(data.runtime.calls[0]?.model, 'gpt-6.1-sol');
  assert.equal(data.runtime.calls[0]?.effort, 'xhigh');
  const repeated = data.service.start(startInput({ kind: 'prepare', dayId, message: undefined }));
  assert.equal((await settled(data, repeated.id)).status, 'completed');
  assert.equal(data.runtime.calls.length, 1);
  assert.equal(data.day().sentences.length, 1);
});

test('AI tools require context and task authority, and cannot invent user learning facts', async (t) => {
  const data = fixture(t);
  data.begin();
  const dayId = data.day().id;
  data.runtime.behavior = async (options) => {
    const before = data.study.snapshot();
    const command = (action: MiniAction) => ({
      requestId: randomUUID(),
      expectedRevision: before.revision,
      action,
    });
    assert.throws(
      () =>
        data.tool(
          options,
          'commit',
          command({ type: 'add_sentences', target: 'daily', dayId, sentences: [example(apple)] }),
        ),
      hasCode('AI_CONTEXT_REQUIRED'),
    );
    assert.throws(
      () => data.service.tool(options.jobId, 'wrong-token', 'context', {}),
      hasCode('AI_TASK_EXPIRED'),
    );
    data.read(options);
    for (const action of [
      { type: 'mark_studied', target: 'daily', dayId, word: apple },
      {
        type: 'choose_judgment',
        target: 'daily',
        dayId,
        session: 'review',
        word: apple,
        judgment: 'clear',
      },
      {
        type: 'submit_spelling',
        target: 'daily',
        dayId,
        session: 'learning',
        word: apple,
        answer: 'apple',
        advanceOnCorrect: true,
      },
      {
        type: 'submit_translation',
        target: 'daily',
        dayId,
        taskId: 'invented',
        answer: 'invented answer',
      },
    ] satisfies MiniAction[]) {
      assert.throws(
        () => data.tool(options, 'commit', command(action)),
        hasCode('AI_ACTION_FORBIDDEN'),
      );
      assert.throws(
        () => data.study.aiCommand(command(action)),
        hasCode('MINI_AI_ACTION_FORBIDDEN'),
      );
    }
    assert.throws(
      () =>
        data.tool(
          options,
          'commit',
          command({
            type: 'add_sentences',
            target: 'daily',
            dayId: 'another-group',
            sentences: [example(apple)],
          }),
        ),
      hasCode('AI_TARGET_INVALID'),
    );
    assert.throws(
      () =>
        data.tool(
          options,
          'commit',
          command({ type: 'add_sentences', target: 'daily', dayId, sentences: [example(book)] }),
        ),
      (error) => error instanceof LearningError,
    );
    assert.deepEqual(data.study.snapshot(), before);
    data.commit(options, {
      type: 'add_sentences',
      target: 'daily',
      dayId,
      sentences: [example(apple)],
    });
  };
  const job = data.service.start(startInput({ kind: 'prepare', dayId, message: undefined }));
  assert.equal((await settled(data, job.id)).status, 'completed');
  assert.deepEqual(data.day().studiedWords, []);
  assert.deepEqual(data.day().translation, []);
});

test('advisor plan and memory changes use real service receipts and saved user-message identity', async (t) => {
  const data = fixture(t);
  data.runtime.behavior = async (options) => {
    const context = data.read(options);
    assert.ok(context.sourceMessageId);
    assert.throws(
      () =>
        data.tool(options, 'commit', {
          requestId: randomUUID(),
          expectedRevision: context.revision,
          action: {
            type: 'remember_preference',
            target: 'daily',
            key: 'pace',
            value: '慢一点',
            sourceMessageId: randomUUID(),
          },
        }),
      hasCode('AI_MESSAGE_SOURCE_INVALID'),
    );
    data.commit(options, {
      type: 'set_today_plan',
      target: 'daily',
      date: '2026-11-13',
      timezone,
      mode: 'rest',
      wordLimit: 10,
      newWordLimit: 5,
    });
    data.commit(options, {
      type: 'remember_preference',
      target: 'daily',
      key: 'pace',
      value: '每次少量学习',
      sourceMessageId: context.sourceMessageId,
    });
    options.onText('今天休息，记住了你希望每次少量学习。');
  };
  const job = data.service.start(
    startInput({ message: '今天不学了，并且记住我希望每次少学一些。' }),
  );
  assert.equal((await settled(data, job.id)).status, 'completed');
  assert.equal(data.study.snapshot().planning.dailyOverrides.at(-1)?.mode, 'rest');
  assert.equal(data.study.snapshot().teaching.memories.length, 1);
  assert.equal(data.ai.job(job.id).receipts.length, 2);
});

test('a saved primary result stays completed when the runtime fails afterwards', async (t) => {
  const data = fixture(t);
  data.begin();
  const dayId = data.day().id;
  data.runtime.behavior = async (options) => {
    data.commit(options, {
      type: 'add_sentences',
      target: 'daily',
      dayId,
      sentences: [example(apple)],
    });
    throw new Error('transport failed after commit');
  };
  const job = data.service.start(startInput({ kind: 'prepare', dayId, message: undefined }));
  assert.equal((await settled(data, job.id)).status, 'completed');
  assert.equal(data.day().sentences.length, 1);
  data.service.retry({ requestId: randomUUID(), jobId: job.id });
  await setImmediate();
  assert.equal(data.runtime.calls.length, 1);
  assert.equal(data.day().sentences.length, 1);
});

test('a disconnected lesson retries only the missing targets and retires its old turn token', async (t) => {
  const data = fixture(t, [apple, book]);
  data.begin();
  const dayId = data.day().id;
  let runs = 0;
  data.runtime.behavior = async (options) => {
    runs += 1;
    if (runs === 2) {
      assert.deepEqual(
        data.day().sentences.map((sentence) => sentence.word),
        [apple],
      );
      const previous = data.runtime.calls[0];
      assert.ok(previous);
      assert.throws(() => data.read(previous), hasCode('AI_TASK_EXPIRED'));
    }
    data.commit(options, {
      type: 'add_sentences',
      target: 'daily',
      dayId,
      sentences: [example(runs === 1 ? apple : book)],
    });
    if (runs === 1) throw new CodexError('CODEX_DISCONNECTED', '连接中断');
  };
  const job = data.service.start(startInput({ kind: 'prepare', dayId, message: undefined }));
  assert.equal((await settled(data, job.id)).status, 'completed');
  assert.equal(runs, 2);
  assert.equal(data.ai.job(job.id).receipts.length, 2);
  assert.equal(data.day().sentences.length, 2);
});

test('lesson retries stop after three timeouts, leave recoverable work, and respect cancellation', async (t) => {
  const data = fixture(t);
  data.begin();
  const dayId = data.day().id;
  data.runtime.behavior = async () => {
    throw new CodexError('CODEX_TIMEOUT', '暂时超时');
  };
  const job = data.service.start(startInput({ kind: 'prepare', dayId, message: undefined }));
  assert.equal((await settled(data, job.id)).status, 'failed');
  assert.equal(data.runtime.calls.length, 4);
  assert.deepEqual(data.day().sentences, []);
  data.service.retry({ requestId: randomUUID(), jobId: job.id });
  await setImmediate();
  assert.match(data.ai.job(job.id).progress, /自动重试/);
  data.service.cancel({ requestId: randomUUID(), jobId: job.id });
  assert.equal((await settled(data, job.id)).status, 'cancelled');
  assert.equal(data.runtime.calls.length, 5);
  data.runtime.behavior = async (options) => {
    data.commit(options, {
      type: 'add_sentences',
      target: 'daily',
      dayId,
      sentences: [example(apple)],
    });
  };
  data.service.retry({ requestId: randomUUID(), jobId: job.id });
  assert.equal((await settled(data, job.id)).status, 'completed');
  assert.equal(data.runtime.calls.length, 6);
});

test('a configuration failure waits for explicit repair without repeating the model request', async (t) => {
  const data = fixture(t);
  data.begin();
  data.runtime.behavior = async () => {
    throw new CodexError('CODEX_LOGIN_REQUIRED', '需要登录');
  };
  const job = data.service.start(
    startInput({ kind: 'prepare', dayId: data.day().id, message: undefined }),
  );
  assert.equal((await settled(data, job.id)).status, 'failed');
  assert.equal(data.runtime.calls.length, 1);
});

test('rollover retires a running lesson before its next write and replays earlier receipts without a new model turn', async (t) => {
  let clock = now();
  const data = fixture(t, [apple], () => clock);
  data.begin();
  const dayId = data.day().id;
  const input = startInput({ kind: 'prepare', dayId, message: undefined });
  data.runtime.behavior = async () => {
    throw new Error('first turn interrupted');
  };
  const job = data.service.start(input);
  assert.equal((await settled(data, job.id)).status, 'failed');
  data.runtime.behavior = async (options) => {
    await new Promise<void>((resolve) =>
      options.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
  };
  const retry = { requestId: randomUUID(), jobId: job.id };
  data.service.retry(retry);
  await setImmediate();
  const turn = data.runtime.calls.at(-1);
  assert.ok(turn);
  const current = data.read(turn);
  clock = new Date('2026-11-14T04:00:00Z');
  const before = data.study.snapshot();
  assert.throws(
    () =>
      data.tool(turn, 'commit', {
        requestId: randomUUID(),
        expectedRevision: current.revision,
        action: { type: 'add_sentences', target: 'daily', dayId, sentences: [example(apple)] },
      }),
    hasCode('AI_TARGET_EXPIRED'),
  );
  assert.equal((await settled(data, job.id)).status, 'cancelled');
  assert.equal(turn.signal.aborted, true);
  assert.deepEqual(data.study.snapshot(), before);
  assert.equal(data.service.start(input).id, job.id);
  assert.equal(data.service.retry(retry).id, job.id);
  for (const kind of ['prepare', 'writing'] as const)
    assert.throws(
      () => data.service.start(startInput({ kind, dayId })),
      hasCode('AI_TARGET_EXPIRED'),
    );
  assert.throws(
    () => data.service.retry({ requestId: randomUUID(), jobId: job.id }),
    hasCode('AI_TARGET_EXPIRED'),
  );
  assert.equal(data.ai.jobs().length, 1);
  assert.equal(data.runtime.calls.length, 2);
});

test('a stale timeout never reruns the lesson after midnight', async (t) => {
  let clock = now();
  const data = fixture(t, [apple], () => clock);
  data.begin();
  const input = startInput({ kind: 'prepare', dayId: data.day().id, message: undefined });
  data.runtime.behavior = async () => {
    clock = new Date('2026-11-14T04:00:00Z');
    throw new CodexError('CODEX_TIMEOUT', '模型超时');
  };
  assert.equal((await settled(data, data.service.start(input).id)).status, 'cancelled');
  assert.equal(data.runtime.calls.length, 1);
});

test('the next lesson can start when both worker slots belonged to the previous day', async (t) => {
  let clock = now();
  const data = fixture(t, [apple], () => clock);
  data.begin();
  const yesterday = data.day().id;
  data.runtime.behavior = async (options) => {
    if (data.ai.input(options.jobId).dayId === yesterday) {
      await new Promise<void>((resolve) =>
        options.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return;
    }
    data.commit(options, {
      type: 'add_sentences',
      target: 'daily',
      dayId: data.day().id,
      sentences: data.day().learningWords.map(example),
    });
  };
  const lesson = data.service.start(startInput({ kind: 'prepare', dayId: yesterday }));
  const writing = data.service.start(startInput({ kind: 'writing', dayId: yesterday }));
  await setImmediate();
  assert.equal(data.runtime.calls.length, 2);
  clock = new Date('2026-11-14T04:00:00Z');
  data.act({
    type: 'begin',
    target: 'daily',
    deck: [book],
    timezone,
    flowVersion: 'sliding-window-v2',
  });
  assert.notEqual(data.day().id, yesterday);
  const fresh = data.service.start(startInput({ kind: 'prepare', dayId: data.day().id }));
  assert.equal((await settled(data, fresh.id)).status, 'completed');
  assert.equal(data.ai.job(lesson.id).status, 'cancelled');
  assert.equal(data.ai.job(writing.id).status, 'cancelled');
  assert.equal(data.runtime.calls.length, 3);
  assert.deepEqual(
    data.study.snapshot().ledger.days.find((day) => day.id === yesterday)?.sentences,
    [],
  );
  assert.equal(data.day().sentences.length, 1);
});

test('writing retries complete independent prompts without duplicating partially published work', async (t) => {
  const data = fixture(t, [apple, book]);
  data.begin();
  const dayId = data.day().id;
  data.act({
    type: 'add_sentences',
    target: 'daily',
    dayId,
    sentences: [example(apple), example(book)],
  });
  let runs = 0;
  data.runtime.behavior = async (options) => {
    const index = runs++;
    const word = data.day().learningWords[index];
    const direction = data.day().directions[index];
    assert.ok(word && direction);
    data.commit(options, {
      type: 'publish_writing',
      target: 'daily',
      dayId,
      prompts: [
        {
          id: randomUUID(),
          sentence: {
            word,
            english: `We need ${word.spelling} today.`,
            chinese: `今天需要${word.meaning}。`,
          },
          direction,
          focusIds: [],
        },
      ],
    });
    if (runs === 1) throw new Error('only first prompt saved');
  };
  const job = data.service.start(startInput({ kind: 'writing', dayId, message: undefined }));
  assert.equal((await settled(data, job.id)).status, 'failed');
  const originalPrompt = data.day().writingPrompts?.[0];
  assert.ok(originalPrompt);
  data.service.retry({ requestId: randomUUID(), jobId: job.id });
  assert.equal((await settled(data, job.id)).status, 'completed');
  assert.equal(data.day().writingPrompts?.length, 2);
  assert.deepEqual(data.day().writingPrompts?.[0], originalPrompt);
  assert.deepEqual(data.day().translation, []);
});

test('chat text claiming success never substitutes for a real primary publication', async (t) => {
  const data = fixture(t);
  data.begin();
  data.runtime.behavior = async (options) => options.onText('例句已经全部保存。');
  const job = data.service.start(
    startInput({ kind: 'prepare', dayId: data.day().id, message: undefined }),
  );
  assert.equal((await settled(data, job.id)).status, 'failed');
  assert.deepEqual(data.day().sentences, []);
  assert.deepEqual(data.ai.job(job.id).receipts, []);
});

test('new teaching feedback requires a display grade for its assigned answer and preserves scheduling', async (t) => {
  let clock = now();
  const data = fixture(t, [apple], () => clock);
  data.begin();
  const attempt = prepareWriting(data);
  const dayId = data.day().id;
  const feedback = {
    expressionGrade: 'natural' as const,
    comment: '意思表达清楚。',
    tip: '留意表达。',
    usefulPhrase: 'an apple',
    strengths: ['信息完整'],
    improvements: [],
    keyPoints: ['an apple'],
    referenceTranslation: '我们今天需要一个苹果。',
  };
  const original = structuredClone(attempt);
  const originalSchedule = data.day().scheduleUpdates;
  clock = new Date('2026-11-14T04:00:00Z');
  data.runtime.behavior = async (options) => {
    const context = data.read(options);
    assert.throws(
      () =>
        data.tool(options, 'commit', {
          requestId: randomUUID(),
          expectedRevision: context.revision,
          action: {
            type: 'qualitative_feedback',
            target: 'daily',
            dayId,
            attemptId: randomUUID(),
            feedback,
          },
        }),
      hasCode('AI_TARGET_INVALID'),
    );
    const requestId = randomUUID();
    const action = {
      type: 'qualitative_feedback' as const,
      target: 'daily' as const,
      dayId,
      attemptId: attempt.id,
      feedback,
    };
    const incomplete = { ...action, feedback: { ...feedback, expressionGrade: undefined } };
    const toolSchema = z.union(miniAiActionOptions('feedback'));
    assert.equal(toolSchema.safeParse(incomplete).success, false);
    assert.equal(toolSchema.safeParse(action).success, true);
    assert.throws(() => data.commit(options, incomplete, requestId), z.ZodError);
    assert.throws(
      () =>
        data.study.aiCommand({ requestId, expectedRevision: context.revision, action: incomplete }),
      z.ZodError,
    );
    assert.equal(data.study.commandReceipt(requestId), null);
    assert.deepEqual(data.ai.pendingTools(), []);
    data.commit(options, action, requestId);
  };
  const job = data.service.start(
    startInput({ kind: 'feedback', dayId, attemptId: attempt.id, message: undefined }),
  );
  assert.equal((await settled(data, job.id)).status, 'completed');
  const saved = data.day().translation.at(-1);
  assert.ok(saved);
  assert.equal(saved.answer, original.answer);
  assert.deepEqual(saved.task, original.task);
  assert.deepEqual(saved.feedback, feedback);
  assert.deepEqual(data.day().scheduleUpdates, originalSchedule);
});

test(
  'AI HTTP normalizes uppercase UUIDs for starts, controls and case-insensitive request replays',
  { timeout: 5000 },
  async (t) => {
    const study = new MiniStore(':memory:', { now, timezone });
    initialize(study);
    const ai = new MiniAiStore(':memory:', now);
    ai.importLegacy({ requestId: randomUUID(), conversations: [] });
    const runtime = new FakeRuntime();
    let release = () => {};
    runtime.behavior = async (options) => {
      await new Promise<void>((resolve) => {
        release = resolve;
        options.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      options.onText('完成这条消息。');
    };
    const service = new MiniAiService(study, ai, runtime);
    service.setBaseUrl('http://127.0.0.1:12345');
    const authorization = `Bearer ${'a'.repeat(64)}`;
    const app = buildApp({ mini: { store: study, token: 'a'.repeat(64), ai: service } });
    t.after(() => app.close());
    const post = async (path: string, payload: Record<string, unknown>) => {
      const result = await app.inject({
        method: 'POST',
        url: `/api/mini/ai/${path}`,
        headers: { authorization },
        payload,
      });
      assert.equal(result.statusCode, 200, result.body);
      return result;
    };
    const waitForRun = async (count: number) => {
      const deadline = Date.now() + 1000;
      while (runtime.calls.length < count && Date.now() < deadline) await setImmediate();
      assert.equal(runtime.calls.length, count);
    };
    const publicJob = z.object({ id: z.string(), requestId: z.string(), status: z.string() });
    const input = startInput();
    const started = publicJob.parse(
      (await post('start', { ...input, requestId: input.requestId.toUpperCase() })).json(),
    );
    assert.equal(started.requestId, input.requestId);
    assert.equal(started.id, started.id.toLowerCase());
    await waitForRun(1);
    const repeated = publicJob.parse((await post('start', input)).json());
    assert.equal(repeated.id, started.id);
    assert.equal(
      ai.messages(input.conversationId).filter((message) => message.role === 'user').length,
      1,
    );
    const cancel = { requestId: randomUUID(), jobId: started.id };
    const cancelled = publicJob.parse(
      (
        await post('cancel', {
          requestId: cancel.requestId.toUpperCase(),
          jobId: cancel.jobId.toUpperCase(),
        })
      ).json(),
    );
    assert.equal(cancelled.id, started.id);
    assert.equal(cancelled.status, 'cancelled');
    await setImmediate();
    const retry = { requestId: randomUUID(), jobId: started.id };
    await post('retry', {
      requestId: retry.requestId.toUpperCase(),
      jobId: retry.jobId.toUpperCase(),
    });
    await waitForRun(2);
    assert.equal(publicJob.parse((await post('retry', retry)).json()).id, started.id);
    assert.equal(publicJob.parse((await post('cancel', cancel)).json()).status, 'running');
    assert.equal(runtime.calls.at(-1)?.signal.aborted, false);
    assert.equal(runtime.calls.length, 2);
    release();
    const deadline = Date.now() + 1000;
    while (ai.job(started.id).status !== 'completed' && Date.now() < deadline) await setImmediate();
    assert.equal(ai.job(started.id).status, 'completed');
    assert.equal(ai.messages(input.conversationId).length, 2);
    const clear = { requestId: randomUUID(), conversationId: input.conversationId };
    await post('clear', { ...clear, requestId: clear.requestId.toUpperCase() });
    await post('clear', clear);
    assert.deepEqual(ai.messages(input.conversationId), []);
    assert.equal(ai.snapshot().jobs.length, 1);
  },
);

test(
  'actual stdio MCP reads task-scoped HTTP context and publishes with a durable receipt',
  { timeout: 15000 },
  async (t) => {
    const study = new MiniStore(':memory:', { now, timezone });
    initialize(study);
    study.command({
      requestId: randomUUID(),
      expectedRevision: study.snapshot().revision,
      action: { type: 'begin', target: 'daily', deck: [apple], timezone },
    });
    const day = study.snapshot().ledger.days.at(-1);
    assert.ok(day);
    const ai = new MiniAiStore(':memory:', now);
    ai.importLegacy({ requestId: randomUUID(), conversations: [] });
    const runtime = new FakeRuntime();
    const service = new MiniAiService(study, ai, runtime);
    const app = buildApp({ mini: { store: study, token: 'a'.repeat(64), ai: service } });
    t.after(() => app.close());
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    service.setBaseUrl(address);
    const textResult = z.object({
      content: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1),
    });
    runtime.behavior = async (options) => {
      const client = new Client({ name: 'mini-ai-regression', version: '1.0.0' });
      const transport = new StdioClientTransport({
        command: options.mcp.command,
        args: options.mcp.args,
        env: options.mcp.env,
        stderr: 'pipe',
      });
      try {
        await client.connect(transport);
        assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
          'learning_commit',
          'learning_get_context',
          'learning_get_history',
          'learning_get_word',
        ]);
        const contextResult = await client.callTool({
          name: 'learning_get_context',
          arguments: {},
        });
        assert.notEqual(contextResult.isError, true);
        const text = textResult.parse(contextResult).content[0]?.text;
        assert.ok(text);
        const context = contextSchema.parse(JSON.parse(text));
        const input = {
          requestId: randomUUID(),
          expectedRevision: context.revision,
          action: {
            type: 'add_sentences',
            target: 'daily',
            dayId: day.id,
            sentences: [example(apple)],
          },
        };
        const publication = await client.callTool({ name: 'learning_commit', arguments: input });
        assert.notEqual(publication.isError, true);
        assert.deepEqual(
          (await client.callTool({ name: 'learning_commit', arguments: input })).content,
          publication.content,
        );
        const history = await client.callTool({
          name: 'learning_get_history',
          arguments: { limit: 5 },
        });
        assert.notEqual(history.isError, true);
        const word = await client.callTool({
          name: 'learning_get_word',
          arguments: { word: apple },
        });
        assert.notEqual(word.isError, true);
        const foreign = await app.inject({
          method: 'POST',
          url: `/api/internal/mini-ai/${options.jobId}`,
          headers: {
            authorization: `Bearer ${options.mcp.env.LINGOWEAVE_MINI_AI_TOKEN}`,
            origin: address,
          },
          payload: { action: 'context' },
        });
        assert.equal(foreign.statusCode, 403);
      } finally {
        await client.close();
      }
    };
    const job = service.start(startInput({ kind: 'prepare', dayId: day.id, message: undefined }));
    const deadline = Date.now() + 5000;
    while (['queued', 'running'].includes(ai.job(job.id).status) && Date.now() < deadline)
      await setImmediate();
    assert.equal(ai.job(job.id).status, 'completed');
    assert.equal(ai.job(job.id).receipts.length, 1);
    assert.equal(study.snapshot().ledger.days.at(-1)?.sentences.length, 1);
    const expired = await app.inject({
      method: 'POST',
      url: `/api/internal/mini-ai/${job.id}`,
      headers: { authorization: `Bearer ${runtime.calls[0]?.mcp.env.LINGOWEAVE_MINI_AI_TOKEN}` },
      payload: { action: 'context' },
    });
    assert.equal(expired.statusCode, 403);
  },
);

test('restart reconciles a committed command without an AI receipt and interrupts unsaved work', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-mini-ai-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const study = new MiniStore(join(directory, 'mini.sqlite'), { now, timezone });
  initialize(study);
  t.after(() => study.close());
  study.command({
    requestId: randomUUID(),
    expectedRevision: study.snapshot().revision,
    action: { type: 'begin', target: 'daily', deck: [apple], timezone },
  });
  const day = study.snapshot().ledger.days.at(-1);
  assert.ok(day);
  const filename = join(directory, 'ai.sqlite');
  let ai = new MiniAiStore(filename, now);
  let closeAi: () => void | Promise<void> = () => ai.close();
  t.after(() => closeAi());
  ai.importLegacy({ requestId: randomUUID(), conversations: [] });
  const prepared = ai.start(startInput({ kind: 'prepare', dayId: day.id, message: undefined })).job;
  ai.update(prepared.id, (job) => {
    job.status = 'running';
  });
  const command: MiniCommand = {
    requestId: randomUUID(),
    expectedRevision: study.snapshot().revision,
    action: { type: 'add_sentences', target: 'daily', dayId: day.id, sentences: [example(apple)] },
  };
  ai.toolCommand(prepared.id, 'learning_commit', command);
  study.aiCommand(command);
  const interrupted = ai.start(
    startInput({ conversationId: 'unfinished', message: '这是不能丢失的原始消息。' }),
  ).job;
  ai.update(interrupted.id, (job) => {
    job.status = 'running';
  });
  ai.close();
  ai = new MiniAiStore(filename, now);
  const runtime = new FakeRuntime();
  const service = new MiniAiService(study, ai, runtime);
  closeAi = () => service.close();
  assert.equal(ai.job(prepared.id).status, 'completed');
  assert.equal(ai.job(prepared.id).receipts.length, 1);
  assert.equal(ai.job(interrupted.id).status, 'interrupted');
  assert.equal(ai.userMessage(interrupted.id)?.text, '这是不能丢失的原始消息。');
  assert.equal(study.snapshot().ledger.days.at(-1)?.sentences.length, 1);
  assert.equal(runtime.calls.length, 0);
});

test('restart recovers an original gradeless teaching receipt without rewriting its answer or calling the model', async (t) => {
  const f = fixture(t);
  f.begin();
  const attempt = prepareWriting(f);
  const dayId = f.day().id;
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-old-feedback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'mini-ai.sqlite');
  let ai = new MiniAiStore(path, now);
  ai.importLegacy({ requestId: randomUUID(), conversations: [] });
  const job = ai.start(
    startInput({ kind: 'feedback', dayId, attemptId: attempt.id, message: undefined }),
  ).job;
  ai.update(job.id, (row) => {
    row.status = 'running';
  });
  const old: MiniCommand = {
    requestId: randomUUID(),
    expectedRevision: f.study.snapshot().revision,
    action: {
      type: 'qualitative_feedback',
      target: 'daily',
      dayId,
      attemptId: attempt.id,
      feedback: {
        comment: '旧点评',
        tip: '',
        usefulPhrase: '',
        strengths: [],
        improvements: [],
        keyPoints: [],
        referenceTranslation: attempt.answer,
      },
    },
  };
  ai.toolCommand(job.id, 'learning_commit', old);
  // Seed the formerly accepted wire body and its receipt using the legacy client path.
  const beforeRestart = f.study.command(old);
  ai.close();
  ai = new MiniAiStore(path, now);
  const runtime = new FakeRuntime();
  const restored = new MiniAiService(f.study, ai, runtime);
  t.after(() => restored.close());
  assert.equal(ai.job(job.id).status, 'completed');
  assert.deepEqual(
    ai.job(job.id).receipts.map((row) => row.requestId),
    [old.requestId],
  );
  assert.deepEqual(ai.pendingTools(), []);
  assert.deepEqual(
    f.study.aiCommand(old),
    beforeRestart,
    'a historical receipt is checked before new-AI grading rules',
  );
  assert.equal(f.day().translation[0]?.feedback?.expressionGrade, undefined);
  assert.equal(runtime.calls.length, 0);
});

test('restart and clear include tasks older than the fifty-task UI snapshot', async (t) => {
  const study = new MiniStore(':memory:', { now, timezone });
  initialize(study);
  const ai = new MiniAiStore(':memory:', now);
  ai.importLegacy({ requestId: randomUUID(), conversations: [] });
  const first = ai.start(startInput({ conversationId: 'old' })).job;
  ai.update(first.id, (job) => {
    job.status = 'running';
  });
  for (let index = 0; index < 51; index += 1) {
    const job = ai.start(startInput({ conversationId: `conversation-${index}` })).job;
    ai.finish(job.id, 'completed');
  }
  assert.equal(ai.snapshot().jobs.length, 50);
  const service = new MiniAiService(study, ai, new FakeRuntime());
  t.after(async () => {
    await service.close();
    study.close();
  });
  assert.equal(ai.job(first.id).status, 'interrupted');
  service.clear({ requestId: randomUUID(), conversationId: 'old' });
  assert.equal(ai.job(first.id).status, 'cancelled');
  assert.deepEqual(ai.messages('old'), []);
});

test('v2 preparation covers reserves and later groups receive only their missing independent writing prompts', async (t) => {
  const deck = [
    apple,
    book,
    ...['bag', 'desk', 'door', 'pen', 'cup'].map((spelling) => ({
      spelling,
      meaning: spelling,
      phonetic: '',
    })),
  ];
  const data = fixture(t, deck);
  data.act({
    type: 'set_long_term_plan',
    target: 'daily',
    plan: {
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      wordLimit: 10,
      newWordLimit: 5,

      dailyNewGoal: 2,
      groupSize: 1,
    },
  });
  data.act({ type: 'begin', target: 'daily', timezone, deck, flowVersion: 'sliding-window-v2' });
  const target = { target: 'daily' as const, dayId: data.day().id };
  assert.equal(data.day().learningWords.length, 5);
  assert.equal(miniPreparationWords(data.day()).length, 7);
  let preparationCalls = 0;
  data.runtime.behavior = async (options) => {
    if (data.ai.input(options.jobId).kind === 'prepare') {
      const context = z
        .object({
          day: z.object({
            preparationWords: z.array(z.unknown()),
            activeWindowWords: z.array(z.unknown()),
          }),
        })
        .parse(data.tool(options, 'context'));
      assert.equal(context.day.preparationWords.length, 7);
      assert.equal(context.day.activeWindowWords.length, 5);
      const missing = miniPreparationWords(data.day()).filter(
        (word) =>
          !data.day().sentences.some((sentence) => sentence.word.spelling === word.spelling),
      );
      data.commit(options, {
        ...target,
        type: 'add_sentences',
        sentences: (preparationCalls++ === 0 ? missing.slice(0, 5) : missing).map(example),
      });
    } else {
      const writing = miniWritingWords(data.day());
      const missing = writing.filter(
        (word) =>
          !data
            .day()
            .writingPrompts?.some((prompt) => prompt.sentence.word.spelling === word.spelling),
      );
      assert.equal(missing.length, 1);
      data.commit(options, {
        ...target,
        type: 'publish_writing',
        prompts: missing.map((word) => ({
          id: randomUUID(),
          sentence: {
            word,
            english: `We need ${word.spelling} today.`,
            chinese: `今天要用${word.meaning}。`,
          },
          direction:
            data.day().directions[writing.findIndex((item) => item.spelling === word.spelling)] ??
            'englishToChinese',
          focusIds: [],
        })),
      });
    }
  };
  const preparation = data.service.start(
    startInput({ kind: 'prepare', dayId: target.dayId, message: undefined }),
  );
  assert.equal((await settled(data, preparation.id)).status, 'completed');
  assert.equal(
    preparationCalls,
    2,
    'automatic recovery fills the reserve material missing from the first turn',
  );
  assert.equal(data.day().sentences.length, 7);
  assert.equal(
    data.day().learningWords.length,
    5,
    'preparing reserves does not count them as introduced or learned',
  );
  let previousPrompts = structuredClone(data.day().writingPrompts ?? []);
  for (let group = 0; group < 2; group++) {
    for (let turn = 0; turn < 100; turn++) {
      const visit = currentMiniWindow(data.day())?.visit;
      if (!visit) break;
      const ctx = { ...target, session: 'learning' as const, word: visit.word, visitId: visit.id };
      if (visit.stage > 0) data.act({ ...ctx, type: 'window_choose', remembered: true });
      data.act({
        ...ctx,
        type: 'window_advance',
        ...(visit.stage === 0 ? { remembered: true } : {}),
      });
    }
    const word = data.day().learning?.queue[0];
    assert.ok(word);
    data.act({
      ...target,
      type: 'submit_spelling',
      session: 'learning',
      word,
      answer: word.spelling,
      advanceOnCorrect: false,
    });
    data.act({ ...target, type: 'advance_spelling', session: 'learning', word });
    data.act({ ...target, type: 'complete_learning' });
    const job = data.service.start(
      startInput({ kind: 'writing', dayId: target.dayId, message: undefined }),
    );
    assert.equal((await settled(data, job.id)).status, 'completed');
    assert.equal(data.day().writingPrompts?.length, group + 1);
    assert.deepEqual(data.day().writingPrompts?.slice(0, group), previousPrompts);
    previousPrompts = structuredClone(data.day().writingPrompts ?? []);
    const task = currentTranslation(data.day());
    assert.ok(task);
    data.act({ ...target, type: 'submit_translation', taskId: task.id, answer: '真实测试答案' });
    data.act({ ...target, type: 'advance_translation', taskId: task.id });
  }
  assert.equal(data.day().flow?.completed.length, 2);
  assert.equal(
    data.runtime.calls.length,
    4,
    'two preparation attempts and one writing request per group',
  );
});
