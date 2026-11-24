// Opt-in acceptance with the selected real model; never points at a personal mini service.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../apps/server/dist/app.js';
import { CodexBridge } from '../apps/server/dist/codex/bridge.js';
import { MiniAiService } from '../apps/server/dist/mini-ai-service.js';
import { MiniAiStore } from '../apps/server/dist/mini-ai-store.js';
import { MiniStore } from '../apps/server/dist/mini-store.js';

const directory = await mkdtemp(join(tmpdir(), 'lingoweave-dialogue-live-'));
const study = new MiniStore(join(directory, 'mini.sqlite'));
const jobs = new MiniAiStore(join(directory, 'ai.sqlite'));
const ai = new MiniAiService(
  study,
  jobs,
  new CodexBridge({
    executable: process.env.CODEX_BIN || 'codex',
    cwd: join(directory, 'workspace'),
    turnTimeoutMs: 180_000,
  }),
);
const token = randomBytes(32).toString('hex');
const app = buildApp({ mini: { store: study, ai, token } });
const timezone = 'Asia/Shanghai';
const conversationId = 'dialogue:' + randomUUID();

try {
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  ai.setBaseUrl(base);
  async function api(route, body) {
    const response = await fetch(base + '/api/mini/' + route, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: 'Bearer ' + token,
        ...(body && { 'content-type': 'application/json' }),
      },
      ...(body && { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    assert.ok(response.ok, route + ': ' + JSON.stringify(payload));
    return payload;
  }
  await api('import', {
    requestId: randomUUID(),
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
    timezone,
  });
  await api('ai/import', { requestId: randomUUID(), conversations: [] });
  const patternsRoute = 'patterns?timezone=' + encodeURIComponent(timezone);
  const initial = await api(patternsRoute);
  assert.ok(initial.batch.length >= 2 && initial.batch.length <= 5);
  const exercise = initial.batch[0];
  const input = { batchId: initial.batchId, patternId: exercise.id, timezone };
  const first = await api('patterns/practice', {
    ...input,
    requestId: randomUUID(),
    answer: 'I do not know.',
    usedHint: false,
  });
  assert.equal(first.correct, false);
  const next = await api('patterns/practice', {
    ...input,
    requestId: randomUUID(),
    answer: first.reference,
    usedHint: true,
  });
  assert.ok(next.snapshot.completedIds.includes(exercise.id));
  const before = await api('snapshot');
  const patternsBefore = await api(patternsRoute);
  async function turn(fields) {
    const start = await api('ai/start', {
      requestId: randomUUID(),
      kind: 'dialogue',
      timezone,
      conversationId,
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
      ...fields,
    });
    let job = start;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) {
        console.log('Retrying the same stored turn:', job.error);
        job = await api('ai/retry', { requestId: randomUUID(), jobId: start.id });
      }
      const deadline = Date.now() + 210_000;
      while (['queued', 'running'].includes(job.status) && Date.now() < deadline) {
        await delay(400);
        job = await api('ai/jobs/' + start.id);
      }
      if (job.status !== 'failed') break;
    }
    assert.equal(job.status, 'completed', job.error || job.progress);
    assert.ok(job.text.trim() && /[a-z]/i.test(job.text) && !/\p{Script=Han}/u.test(job.text));
    assert.equal(job.model, 'gpt-6.1-sol');
    assert.equal(job.effort, 'xhigh');
    assert.deepEqual(job.receipts, []);
    console.log(job.text);
  }
  await turn({});
  await turn({ message: 'Hello! ' + first.reference });
  await turn({ dialogueStep: 'reflect' });
  const chat = (await api('ai/snapshot')).messages.filter(
    (m) => m.conversationId === conversationId,
  );
  assert.deepEqual(
    chat.map((m) => m.role),
    ['assistant', 'user', 'assistant', 'assistant'],
  );
  assert.deepEqual(await api('snapshot'), before);
  assert.deepEqual(await api(patternsRoute), patternsBefore);
  console.log(
    'Verified three live English turns without changing study, frame practice, or schedules.',
  );
} finally {
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
