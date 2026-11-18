import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  miniAudioResultSchema,
  type MiniAudioRuntime,
  type RuntimeStatus,
} from '@lingoweave/contracts';
import { z } from 'zod';
import { buildApp } from './app.js';
import { MiniAiService } from './mini-ai-service.js';
import { MiniAiStore } from './mini-ai-store.js';
import { MiniAudioService } from './mini-audio-service.js';
import { MiniAudioStore } from './mini-audio-store.js';
import type { MiniTtsRuntime } from './mini-audio-runtime.js';
import { MiniStore } from './mini-store.js';
import type { PreparationRuntime } from './preparation-service.js';

const apple = { spelling: 'apple', meaning: '苹果', phonetic: '' };
const target = { kind: 'word' as const, word: apple };
const profile: MiniAudioRuntime = {
  available: true,
  profile: {
    modelId: 'test',
    modelRevision: 'test',
    engine: 'mlx-audio',
    engineVersion: 'test',
    generationVersion: 'test',
    language: 'English',
    temperature: 0.7,
    maxTokens: 2048,
  },
  error: null,
};
function wav() {
  const bytes = Buffer.alloc(44 + 4800 * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24);
  bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(9600, 40);
  for (let index = 0; index < 4800; index++)
    bytes.writeInt16LE(
      Math.round(Math.sin((index * 2 * Math.PI * 440) / 24000) * 2000),
      44 + index * 2,
    );
  return bytes;
}
class Tts implements MiniTtsRuntime {
  calls = 0;
  async status() {
    return profile;
  }
  async generate(input: Parameters<MiniTtsRuntime['generate']>[0]) {
    this.calls++;
    await writeFile(input.outputFile, wav(), { flag: 'wx' });
  }
  async close() {}
}
class Ai implements PreparationRuntime {
  behavior: (input: Parameters<PreparationRuntime['prepare']>[0]) => Promise<void> = async () => {};
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
  async prepare(input: Parameters<PreparationRuntime['prepare']>[0]) {
    await this.behavior(input);
    return { threadId: 'test', model: 'gpt-6.1-sol' };
  }
  async close() {}
}

test(
  'actual advisor MCP can inspect and generate one audio asset without playing or inventing learning facts',
  { timeout: 10000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'lingoweave-ai-audio-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const study = new MiniStore(':memory:');
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
      action: { type: 'begin', target: 'daily', deck: [apple], timezone: 'Asia/Shanghai' },
    });
    const audioStore = new MiniAudioStore(':memory:');
    const tts = new Tts();
    const audio = new MiniAudioService(study, audioStore, tts, {
      directory: join(directory, 'audio'),
    });
    const aiStore = new MiniAiStore(':memory:');
    aiStore.importLegacy({ requestId: randomUUID(), conversations: [] });
    const ai = new Ai(),
      service = new MiniAiService(study, aiStore, ai, audio);
    const app = buildApp({ mini: { store: study, token: 'a'.repeat(64), ai: service, audio } });
    t.after(() => app.close());
    service.setBaseUrl(await app.listen({ host: '127.0.0.1', port: 0 }));
    ai.behavior = async (options) => {
      const client = new Client({ name: 'test-advisor-audio', version: '1' });
      await client.connect(
        new StdioClientTransport({
          command: options.mcp.command,
          args: options.mcp.args,
          env: options.mcp.env,
          stderr: 'ignore',
        }),
      );
      try {
        assert.deepEqual(
          (await client.listTools()).tools.map((tool) => tool.name),
          options.tools,
        );
        const content = (result: Awaited<ReturnType<typeof client.callTool>>) => {
          assert.notEqual(result.isError, true, JSON.stringify(result.content));
          const block = z
            .array(z.object({ type: z.literal('text'), text: z.string() }))
            .parse(result.content)[0];
          assert.ok(block);
          return JSON.parse(block.text);
        };
        content(await client.callTool({ name: 'learning_get_context', arguments: {} }));
        const before = study.snapshot();
        const empty = miniAudioResultSchema.parse(
          content(await client.callTool({ name: 'learning_get_audio', arguments: { target } })),
        );
        assert.equal(empty.asset, null);
        const request = { requestId: randomUUID(), target, operation: 'ensure' };
        const first = miniAudioResultSchema.parse(
          content(await client.callTool({ name: 'learning_generate_audio', arguments: request })),
        );
        const repeated = miniAudioResultSchema.parse(
          content(await client.callTool({ name: 'learning_generate_audio', arguments: request })),
        );
        assert.equal(first.job?.id, repeated.job?.id);
        const deadline = Date.now() + 3000;
        let result = first;
        while (!result.asset && Date.now() < deadline) {
          await setImmediate();
          result = miniAudioResultSchema.parse(
            content(await client.callTool({ name: 'learning_get_audio', arguments: { target } })),
          );
        }
        assert.ok(result.asset);
        assert.equal(tts.calls, 1);
        assert.deepEqual(study.snapshot(), before);
        assert.equal(audio.snapshot().playbacks.length, 0);
        const forbidden = await client.callTool({
          name: 'learning_generate_audio',
          arguments: {
            requestId: randomUUID(),
            target: { kind: 'word', word: { spelling: 'invented', meaning: '伪造', phonetic: '' } },
          },
        });
        assert.equal(forbidden.isError, true);
        options.onText('音频已经生成，可在词卡播放。');
      } finally {
        await client.close();
      }
    };
    const job = service.start({
      requestId: randomUUID(),
      kind: 'advisor',
      timezone: 'Asia/Shanghai',
      conversationId: 'advisor',
      message: '请准备当前单词的音频。',
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
    });
    const deadline = Date.now() + 6000;
    while (['queued', 'running'].includes(aiStore.job(job.id).status) && Date.now() < deadline)
      await setImmediate();
    assert.equal(aiStore.job(job.id).status, 'completed', aiStore.job(job.id).error ?? '');
    assert.equal(
      aiStore.job(job.id).receipts.filter((receipt) => receipt.tool === 'learning_generate_audio')
        .length,
      1,
    );
    assert.equal(audio.snapshot().playbacks.length, 0);
    assert.equal(study.snapshot().ledger.days[0]?.learning?.spellingAttempts.length, 0);
  },
);

test(
  'stopping an advisor before the asynchronous audio commit prevents a late queued task',
  { timeout: 5000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'lingoweave-ai-audio-cancel-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const study = new MiniStore(':memory:');
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
      action: { type: 'begin', target: 'daily', deck: [apple], timezone: 'Asia/Shanghai' },
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tts = new Tts();
    tts.status = async () => {
      await gate;
      return profile;
    };
    const audio = new MiniAudioService(study, new MiniAudioStore(':memory:'), tts, {
      directory: join(directory, 'audio'),
    });
    const aiStore = new MiniAiStore(':memory:');
    aiStore.importLegacy({ requestId: randomUUID(), conversations: [] });
    const ai = new Ai(),
      service = new MiniAiService(study, aiStore, ai, audio);
    service.setBaseUrl('http://127.0.0.1:12345');
    t.after(async () => {
      release();
      await service.close();
      await audio.close();
      study.close();
    });
    let attempted = false;
    ai.behavior = async (options) => {
      const token = options.mcp.env.LINGOWEAVE_MINI_AI_TOKEN;
      assert.ok(token);
      service.tool(options.jobId, token, 'context', {});
      const pending = Promise.resolve(
        service.tool(options.jobId, token, 'audio_request', {
          requestId: randomUUID(),
          target,
          operation: 'ensure',
        }),
      );
      const rejected = assert.rejects(pending, { code: 'AI_TASK_EXPIRED' });
      service.cancel({ requestId: randomUUID(), jobId: options.jobId });
      release();
      await rejected;
      attempted = true;
    };
    service.start({
      requestId: randomUUID(),
      kind: 'advisor',
      timezone: 'Asia/Shanghai',
      conversationId: 'advisor',
      message: '准备音频',
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
    });
    const deadline = Date.now() + 2000;
    while (!attempted && Date.now() < deadline) await setImmediate();
    assert.ok(attempted);
    assert.equal(audio.snapshot().jobs.length, 0);
    assert.equal(tts.calls, 0);
  },
);
