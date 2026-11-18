import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function loadMiniToken(filename: string): string {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(filename, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const token = readFileSync(filename, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local mini service token file.');
  chmodSync(filename, 0o600);
  return token;
}
