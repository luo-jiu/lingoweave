import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadMiniToken } from './mini-token.js';

test('local service token is private, stable across restarts, and never silently replaced', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'lingoweave-token-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'service', 'token');
  const first = loadMiniToken(filename);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(loadMiniToken(filename), first);
  assert.equal(statSync(filename).mode & 0o777, 0o600);
  writeFileSync(filename, 'invalid token');
  assert.throws(() => loadMiniToken(filename), /Invalid local mini service token/);
  assert.equal(readFileSync(filename, 'utf8'), 'invalid token');
});
