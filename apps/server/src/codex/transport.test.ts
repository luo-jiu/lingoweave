import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { CodexTransport } from './transport.js';

function child(source: string, options: { requestTimeoutMs?: number; maxLineBytes?: number } = {}) {
  return new CodexTransport({
    executable: process.execPath,
    args: ['-e', source],
    cwd: tmpdir(),
    ...options,
  });
}

test('JSONL correlates out-of-order responses and preserves split UTF-8 notifications', async (t) => {
  const transport = child(`
    const readline = require('node:readline');
    const queue = [];
    readline.createInterface({input:process.stdin}).on('line', line => {
      queue.push(JSON.parse(line));
      if(queue.length === 2) {
        for(const m of queue.reverse()) process.stdout.write(JSON.stringify({id:m.id,result:m.params})+'\\n');
        const message=Buffer.from(JSON.stringify({method:'hello',params:{text:'你好'}})+'\\n');
        const split=message.indexOf(Buffer.from('你'))+1;
        process.stdout.write(message.subarray(0,split));
        setTimeout(()=>process.stdout.write(message.subarray(split)),10);
      }
    });
  `);
  t.after(() => transport.close());
  const notification = new Promise<unknown>((resolve) =>
    transport.onNotification((_method, params) => resolve(params)),
  );
  const results = await Promise.all([
    transport.request('a', { value: 1 }),
    transport.request('b', { value: 2 }),
  ]);
  assert.deepEqual(results, [{ value: 1 }, { value: 2 }]);
  assert.deepEqual(await notification, { text: '你好' });
});

test('invalid protocol and oversized unterminated lines reject pending calls', async (t) => {
  for (const source of [
    'process.stdout.write("not-json\\n");',
    'process.stdout.write("x".repeat(200));',
  ]) {
    const transport = child(`process.stdin.on('data',()=>{${source}});`, { maxLineBytes: 100 });
    t.after(() => transport.close());
    await assert.rejects(transport.request('hello', {}), { code: 'CODEX_PROTOCOL' });
  }
});

test('unexpected process exit rejects all outstanding requests', async (t) => {
  const transport = child('process.stdin.once("data",()=>process.exit(7));');
  t.after(() => transport.close());
  const results = await Promise.allSettled([
    transport.request('first', {}),
    transport.request('second', {}),
  ]);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 2);
});

test('a missing executable and a timed-out request fail without leaving pending promises', async (t) => {
  const missing = new CodexTransport({
    executable: '/lingoweave/nonexistent-codex',
    args: [],
    cwd: tmpdir(),
  });
  t.after(() => missing.close());
  await assert.rejects(missing.request('hello', {}), { code: 'CODEX_UNAVAILABLE' });
  const hanging = child('process.stdin.resume();', { requestTimeoutMs: 50 });
  t.after(() => hanging.close());
  await assert.rejects(hanging.request('hello', {}), { code: 'CODEX_TIMEOUT' });
});

test('unsupported server requests fail visibly without authorizing an action', async (t) => {
  const transport = child(
    `process.stdin.once('data',()=>process.stdout.write(JSON.stringify({id:99,method:'item/commandExecution/requestApproval',params:{}})+'\\n'));`,
  );
  t.after(() => transport.close());
  await assert.rejects(transport.request('hello', {}), { code: 'CODEX_REQUIRES_ACTION' });
});

test('cancelling closes the owned process and rejects its current request', async (t) => {
  const transport = child('process.stdin.resume();');
  t.after(() => transport.close());
  const pending = transport.request('hello', {});
  const rejected = assert.rejects(pending, { code: 'CODEX_CANCELLED' });
  await transport.abort();
  await rejected;
  await transport.close();
});
