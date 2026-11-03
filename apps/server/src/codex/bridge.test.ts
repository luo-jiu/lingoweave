import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { CodexBridge, type PrepareOptions, isolatedThreadConfig } from './bridge.js';

async function fixture(t: TestContext, scenario = 'success', turnTimeoutMs = 1_000) {
  const cwd = await mkdtemp(join(tmpdir(), 'lingoweave-bridge-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const executable = join(cwd, 'codex-mock.cjs');
  await writeFile(
    executable,
    `#!/usr/bin/env node
    const readline = require('node:readline');
    const scenario = ${JSON.stringify(scenario)};
    const send = data => process.stdout.write(JSON.stringify(data)+'\\n');
    readline.createInterface({input:process.stdin}).on('line', line => {
      const m=JSON.parse(line); if(m.id===undefined)return;
      let result={};
      switch(m.method) {
        case 'initialize': result={userAgent:'Codex/0.153.4 test'}; break;
        case 'account/read': result={account:scenario==='login'?null:{type:'chatgpt',email:'private@example.invalid'},requiresOpenaiAuth:true}; break;
        case 'model/list': result={data:[{id:'test-id',model:'test-model',displayName:'Test model',isDefault:true}],nextCursor:null}; break;
        case 'config/read': result={config:{mcp_servers:{unrelated:{enabled:true,token:'private'}},plugins:{external:{enabled:true}}}}; break;
        case 'thread/start':
          if(m.params.config.mcp_servers.unrelated.enabled !== false || m.params.config.plugins.external.enabled !== false) throw Error('scope not isolated');
          result={thread:{id:'thread-1'},model:m.params.model,approvalPolicy:'never',sandbox:{type:'readOnly'}};break;
        case 'mcpServerStatus/list': result={data:[{name:'lingoweave',runtimeStatus:'connected',tools:{learning_get_context:{},learning_publish_materials:{}}}, {name:'unrelated',runtimeStatus:scenario==='foreign'?'connected':'disabled',tools:{}}],nextCursor:null};break;
        case 'turn/start':
          result={turn:{id:'turn-1'}};
          send({id:m.id,result});
          if(scenario==='hang')return;
          send({method:'item/reasoning/textDelta',params:{threadId:'thread-1',turnId:'turn-1',delta:'private reasoning'}});
          send({method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:'turn-1',itemId:'message-1',delta:'正在准备。'}});
          send({method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',item:{type:'agentMessage',id:'message-1',text:'正在准备。'}}});
          send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:scenario==='failed'?'failed':'completed'}}});return;
        case 'turn/interrupt': result={};break;
      }
      send({id:m.id,result});
    });
  `,
    { mode: 0o755 },
  );
  const bridge = new CodexBridge({ cwd, executable, requestTimeoutMs: 1_000, turnTimeoutMs });
  t.after(() => bridge.close());
  return bridge;
}

function options(controller = new AbortController()): PrepareOptions {
  return {
    jobId: 'job-1',
    instructions: 'Prepare one group.',
    mcp: {
      command: process.execPath,
      args: ['mcp.js'],
      env: { LINGOWEAVE_MCP_TOKEN: 'scoped-secret' },
    },
    onText: () => {},
    onProgress: () => {},
    signal: controller.signal,
  };
}

test('status exposes only runtime availability and model metadata, with a shared cached result', async (t) => {
  const bridge = await fixture(t);
  const [first, second] = await Promise.all([bridge.status(), bridge.status()]);
  assert.deepEqual(first, {
    available: true,
    authenticated: true,
    version: '0.153.4',
    models: [{ id: 'test-model', name: 'Test model', isDefault: true }],
    error: null,
  });
  assert.strictEqual(first, second);
  assert.doesNotMatch(JSON.stringify(first), /private|example/);
  assert.strictEqual(await bridge.status(), first);
});

test('logged-out Codex reports a usable action and never starts a preparation turn', async (t) => {
  const bridge = await fixture(t, 'login');
  const status = await bridge.status();
  assert.equal(status.available, true);
  assert.equal(status.authenticated, false);
  assert.deepEqual(status.models, []);
  await assert.rejects(bridge.prepare(options()), { code: 'CODEX_LOGIN_REQUIRED' });
});

test('preparation streams public text exactly once and records the selected thread', async (t) => {
  const bridge = await fixture(t);
  const fragments: string[] = [];
  const threads: unknown[] = [];
  const result = await bridge.prepare({
    ...options(),
    onText: (text) => fragments.push(text),
    onThread: (thread) => threads.push(thread),
  });
  assert.deepEqual(result, { threadId: 'thread-1', model: 'test-model' });
  assert.deepEqual(threads, [result]);
  assert.equal(fragments.join(''), '正在准备。');
});

test('foreign active MCP servers stop preparation before model execution', async (t) => {
  const bridge = await fixture(t, 'foreign');
  await assert.rejects(bridge.prepare(options()), { code: 'CODEX_TOOL_SCOPE' });
});

test('unavailable model, failed turn and timeout are distinguishable safe errors', async (t) => {
  const bridge = await fixture(t);
  await assert.rejects(bridge.prepare({ ...options(), model: 'not-available' }), {
    code: 'CODEX_MODEL_UNAVAILABLE',
  });
  const failed = await fixture(t, 'failed');
  await assert.rejects(failed.prepare(options()), { code: 'CODEX_TURN_FAILED' });
  const hanging = await fixture(t, 'hang', 50);
  await assert.rejects(hanging.prepare(options()), { code: 'CODEX_TURN_TIMEOUT' });
});

test('cancellation before and after a thread starts prevents later text callbacks', async (t) => {
  const bridge = await fixture(t);
  const controller = new AbortController();
  const fragments: string[] = [];
  await assert.rejects(
    bridge.prepare({
      ...options(controller),
      onThread: () => controller.abort(),
      onText: (text) => fragments.push(text),
    }),
    { code: 'CODEX_CANCELLED' },
  );
  assert.deepEqual(fragments, []);
  await assert.rejects(bridge.prepare(options(controller)), { code: 'CODEX_CANCELLED' });
});

test('cancellation during a running turn settles promptly without waiting for its timeout', async (t) => {
  const bridge = await fixture(t, 'hang', 10_000);
  const controller = new AbortController();
  const start = Date.now();
  await assert.rejects(
    bridge.prepare({
      ...options(controller),
      onThread: () => setTimeout(() => controller.abort(), 25),
    }),
    { code: 'CODEX_CANCELLED' },
  );
  assert.ok(Date.now() - start < 5_000);
});

test('isolated configuration overrides every inherited entry without modifying its input', () => {
  const inherited = {
    mcp_servers: { extra: { enabled: true } },
    plugins: { external: { enabled: true } },
  };
  const config = isolatedThreadConfig(inherited, options().mcp);
  assert.deepEqual(config.mcp_servers.extra, { enabled: false });
  assert.deepEqual(config.plugins.external, { enabled: false });
  assert.equal(inherited.mcp_servers.extra.enabled, true);
  assert.equal(inherited.plugins.external.enabled, true);
});
