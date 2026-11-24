import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { CodexBridge, type PrepareOptions } from './bridge.js';

const miniTools = [
  'learning_get_context',
  'learning_get_history',
  'learning_get_word',
  'learning_commit',
];
const requestSchema = z.object({ method: z.string(), params: z.unknown() });
async function fixture(t: TestContext, scenario = 'success', expectedTools = miniTools) {
  const cwd = await mkdtemp(join(tmpdir(), 'lingoweave-mini-bridge-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const executable = join(cwd, 'codex-mock.cjs');
  const log = join(cwd, 'requests.jsonl');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const readline = require('node:readline');
const { appendFileSync } = require('node:fs');
const scenario = ${JSON.stringify(scenario)};
const miniTools = ${JSON.stringify(expectedTools)};
const log = ${JSON.stringify(log)};
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
let accountReads = 0;
let lateAccountRequest;
readline.createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if(message.id===undefined)return;
  appendFileSync(log, JSON.stringify(message)+'\\n');
  let result = {};
  switch(message.method) {
    case 'initialize': result = {userAgent:'Codex/0.153.4 test'}; break;
    case 'account/read':
      accountReads++;
      if (scenario === 'account-persistent' || (scenario === 'account-transient' && accountReads === 1)) {
        send({id:message.id,error:{code:-32603,message:'temporary workspace error'}}); return;
      }
      if (scenario === 'account-forbidden') {
        send({id:message.id,error:{code:-32602,message:'invalid account parameters'}}); return;
      }
      if (scenario === 'account-timeout') {
        if (accountReads === 1) { lateAccountRequest = message.id; return; }
        send({id:lateAccountRequest,result:{account:null,requiresOpenaiAuth:true}});
      }
      result = {account:{type:'chatgpt'},requiresOpenaiAuth:true}; break;
    case 'model/list': result = {data:[
      {id:'default-id',model:'default-model',displayName:'Default',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'medium'}]},
      {id:'selected-id',model:'gpt-6.1-sol',displayName:'Selected',isDefault:false,hidden:scenario==='hidden-model',supportedReasoningEfforts:scenario==='no-effort-metadata'?undefined:[{reasoningEffort:'high'}, {reasoningEffort:'xhigh'}],defaultReasoningEffort:'high'}
    ],nextCursor:null}; break;
    case 'config/read': result = {config:{mcp_servers:{external:{enabled:true},lingoweave:{enabled:true,enabled_tools:['unsafe_old_tool']}},plugins:{external:{enabled:true}}}}; break;
    case 'thread/start': result = {thread:{id:'mini-thread'},model:message.params.model,approvalPolicy:'never',sandbox:{type:'readOnly'}}; break;
    case 'mcpServerStatus/list': {
      const ownTools = [...miniTools];
      if(scenario==='missing-tool')ownTools.pop();
      if(scenario==='extra-tool')ownTools.push('learning_publish_materials');
      result = {data:[
        {name:'lingoweave',runtimeStatus:'connected',tools:Object.fromEntries(ownTools.map(name=>[name,{}]))},
        {name:'external',runtimeStatus:scenario==='foreign-connected'?'connected':'disabled',tools:scenario==='foreign-tools'?{unsafe_tool:{}}:{}}
      ],nextCursor:scenario==='inventory-paginated'?'unverified-next-page':null};
      break;
    }
    case 'turn/start':
      if (scenario === 'turn-rejected') {
        send({id:message.id,error:{code:-32603,message:'failed to start turn'}}); return;
      }
      send({id:message.id,result:{turn:{id:'mini-turn'}}});
      send({method:'turn/completed',params:{threadId:'mini-thread',turn:{id:'mini-turn',status:'completed'}}});
      return;
  }
  send({id:message.id,result});
});


`,
    { mode: 0o755 },
  );
  const bridge = new CodexBridge({ cwd, executable, requestTimeoutMs: 5000, turnTimeoutMs: 5000 });
  t.after(() => bridge.close());
  return {
    bridge,
    async calls() {
      return (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => requestSchema.parse(JSON.parse(line)));
    },
  };
}
function options(): PrepareOptions {
  return {
    jobId: 'mini-task',
    model: 'gpt-6.1-sol',
    effort: 'xhigh',
    tools: miniTools,
    prompt: 'Read assigned context and complete this mini task.',
    instructions: 'Follow the assigned mini task.',
    skill: { name: 'mini-advisor', path: '/scoped/mini-advisor/SKILL.md' },
    mcp: {
      command: process.execPath,
      args: ['mini-ai-mcp.js'],
      env: { LINGOWEAVE_MINI_AI_TOKEN: 'scoped-token', LINGOWEAVE_MINI_AI_KIND: 'advisor' },
    },
    onText: () => {},
    onProgress: () => {},
    signal: new AbortController().signal,
  };
}

test('account read recovers once per child during status and preparation', async (t) => {
  const data = await fixture(t, 'account-transient');
  assert.equal((await data.bridge.status()).authenticated, true);
  assert.equal((await data.bridge.prepare(options())).threadId, 'mini-thread');
  const methods = (await data.calls()).map((call) => call.method);
  assert.equal(methods.filter((method) => method === 'account/read').length, 4);
  assert.equal(methods.filter((method) => method === 'initialize').length, 2);
  assert.equal(methods.filter((method) => method === 'turn/start').length, 1);
});

test('a late account response cannot override a successful retry in the same child', async (t) => {
  const data = await fixture(t, 'account-timeout');
  assert.equal((await data.bridge.status()).authenticated, true);
  assert.deepEqual(
    (await data.calls()).map((call) => call.method),
    ['initialize', 'account/read', 'account/read', 'model/list'],
  );
});

test('persistent account errors stop at the bound and other rejections are not replayed', async (t) => {
  for (const [scenario, rpcCode, retries, turns] of [
    ['account-persistent', -32603, 1, 0],
    ['account-forbidden', -32602, 0, 0],
    ['turn-rejected', -32603, 0, 1],
  ] as const) {
    const data = await fixture(t, scenario);
    await assert.rejects(data.bridge.prepare(options()), { code: 'CODEX_REQUEST_FAILED', rpcCode });
    const methods = (await data.calls()).map((call) => call.method);
    assert.equal(methods.filter((method) => method === 'initialize').length, 1);
    assert.equal(methods.filter((method) => method === 'account/read').length, 1 + retries);
    assert.equal(methods.filter((method) => method === 'turn/start').length, turns);
  }
});

test('mini adapter forwards the chosen model and effort while isolating exactly its four tools', async (t) => {
  const data = await fixture(t);
  const input = options();
  assert.deepEqual(await data.bridge.prepare(input), {
    threadId: 'mini-thread',
    model: 'gpt-6.1-sol',
  });
  const calls = await data.calls();
  const thread = calls.find((call) => call.method === 'thread/start');
  assert.ok(thread);
  const started = z
    .object({
      model: z.string(),
      approvalPolicy: z.literal('never'),
      sandbox: z.literal('read-only'),
      ephemeral: z.literal(true),
      config: z.object({
        mcp_servers: z.object({
          external: z.object({ enabled: z.literal(false) }),
          lingoweave: z.object({
            enabled: z.literal(true),
            enabled_tools: z.array(z.string()),
            env: z.record(z.string(), z.string()),
          }),
        }),
        plugins: z.object({
          external: z.object({ enabled: z.literal(false) }),
          _default: z.object({ enabled: z.literal(false) }),
        }),
      }),
    })
    .parse(thread.params);
  assert.equal(started.model, input.model);
  assert.deepEqual(started.config.mcp_servers.lingoweave.enabled_tools, miniTools);
  assert.deepEqual(started.config.mcp_servers.lingoweave.env, input.mcp.env);
  const turn = calls.find((call) => call.method === 'turn/start');
  assert.ok(turn);
  assert.deepEqual(
    z
      .object({
        threadId: z.string(),
        model: z.string(),
        effort: z.string(),
        input: z.array(z.unknown()),
      })
      .parse(turn.params),
    {
      threadId: 'mini-thread',
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
      input: [
        { type: 'text', text: input.prompt, text_elements: [] },
        { type: 'skill', ...input.skill },
      ],
    },
  );
});

test('mini runtime metadata exposes supported efforts without replacing the selected default', async (t) => {
  const data = await fixture(t);
  const status = await data.bridge.status();
  assert.deepEqual(
    status.models.find((model) => model.id === 'gpt-6.1-sol'),
    {
      id: 'gpt-6.1-sol',
      name: 'Selected',
      isDefault: false,
      supportedReasoningEfforts: ['high', 'xhigh'],
      defaultReasoningEffort: 'high',
    },
  );
});

test('missing, extra, foreign and unverified tools stop mini execution before any model turn', async (t) => {
  for (const scenario of [
    'missing-tool',
    'extra-tool',
    'foreign-connected',
    'foreign-tools',
    'inventory-paginated',
  ]) {
    await t.test(scenario, async (current) => {
      const data = await fixture(current, scenario);
      const threads: unknown[] = [];
      await assert.rejects(
        data.bridge.prepare({ ...options(), onThread: (thread) => threads.push(thread) }),
        { code: 'CODEX_TOOL_SCOPE' },
      );
      assert.deepEqual(threads, []);
      assert.equal(
        (await data.calls()).some((call) => call.method === 'turn/start'),
        false,
      );
    });
  }
});

test('an unavailable or hidden selected model never falls back to the available default model', async (t) => {
  for (const scenario of ['unavailable', 'hidden-model']) {
    await t.test(scenario, async (current) => {
      const data = await fixture(current, scenario);
      await assert.rejects(
        data.bridge.prepare({
          ...options(),
          model: scenario === 'unavailable' ? 'missing-model' : 'gpt-6.1-sol',
        }),
        { code: 'CODEX_MODEL_UNAVAILABLE' },
      );
      const calls = await data.calls();
      assert.equal(
        calls.some((call) => call.method === 'thread/start' || call.method === 'turn/start'),
        false,
      );
    });
  }
});

test('unsupported or unknown selected effort never falls back to the model default effort', async (t) => {
  for (const scenario of ['unsupported-effort', 'no-effort-metadata']) {
    await t.test(scenario, async (current) => {
      const data = await fixture(current, scenario);
      const input = { ...options(), effort: scenario === 'unsupported-effort' ? 'ultra' : 'xhigh' };
      await assert.rejects(data.bridge.prepare(input), { code: 'CODEX_EFFORT_UNAVAILABLE' });
      const calls = await data.calls();
      assert.equal(
        calls.some((call) => call.method === 'thread/start' || call.method === 'turn/start'),
        false,
      );
      assert.equal(input.effort, scenario === 'unsupported-effort' ? 'ultra' : 'xhigh');
    });
  }
});

test('advisor audio tools are scoped explicitly without enabling unrelated tools', async (t) => {
  const names = [...miniTools, 'learning_get_audio', 'learning_generate_audio'];
  const data = await fixture(t, 'success', names);
  await data.bridge.prepare({ ...options(), tools: names });
  const thread = (await data.calls()).find((call) => call.method === 'thread/start');
  assert.ok(thread);
  const config = z
    .object({
      config: z.object({
        mcp_servers: z.object({ lingoweave: z.object({ enabled_tools: z.array(z.string()) }) }),
      }),
    })
    .parse(thread.params);
  assert.deepEqual(config.config.mcp_servers.lingoweave.enabled_tools, names);
});
