import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LearningRequestError, parsePendingAction, sendAction } from '../src/lib/learning-api.ts';

const requestId = 'dcb38aca-8008-401d-913d-2e188f8c3af1';

test('restoring a pending action validates identity and keeps its original request payload', () => {
  assert.deepEqual(parsePendingAction({ kind: 'prepare', requestId, model: 'available-model' }), {
    kind: 'prepare',
    requestId,
    model: 'available-model',
  });
  assert.deepEqual(parsePendingAction({ kind: 'cancel', requestId, jobId: 'job-1' }), {
    kind: 'cancel',
    requestId,
    jobId: 'job-1',
  });
  assert.equal(parsePendingAction({ kind: 'prepare', requestId: 'broken' }), null);
  assert.equal(parsePendingAction({ kind: 'cancel', requestId }), null);
  assert.equal(parsePendingAction({ kind: 'other', requestId }), null);
});

test('retrying an uncertain prepare sends the same request identity and model', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const bodies: unknown[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) throw new TypeError('connection dropped after commit');
    return Response.json({ jobId: 'original-job', reused: true });
  };
  const action = { kind: 'prepare' as const, requestId, model: 'available-model' };
  await assert.rejects(
    sendAction(action),
    (error: unknown) => error instanceof LearningRequestError && !error.definitive,
  );
  assert.deepEqual(await sendAction(action), { jobId: 'original-job', reused: true });
  assert.deepEqual(bodies, [
    { requestId, model: action.model },
    { requestId, model: action.model },
  ]);
});

test('server errors and malformed receipts leave a write outcome unknown', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  for (const response of [
    Response.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed', requestId } },
      { status: 500 },
    ),
    Response.json({ ok: true }),
  ]) {
    globalThis.fetch = async () => response;
    await assert.rejects(
      sendAction({ kind: 'prepare', requestId }),
      (error: unknown) => error instanceof LearningRequestError && !error.definitive,
    );
  }
});

test('a validated rejection is distinct from an unknown write result', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    Response.json(
      { error: { code: 'BAD_REQUEST', message: 'Invalid model', requestId } },
      { status: 400 },
    );
  await assert.rejects(
    sendAction({ kind: 'prepare', requestId }),
    (error: unknown) =>
      error instanceof LearningRequestError &&
      error.definitive &&
      error.message === 'Invalid model',
  );
});
