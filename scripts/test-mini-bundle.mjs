import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdtemp, readFile, readdir, readlink, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const application = resolve(
  process.argv[2] ?? join(root, 'apps/macos/dist/LingoWeave Mini Dev.app'),
);
if (process.platform !== 'darwin' || process.argv.length > 3)
  throw new Error('Usage on macOS: node scripts/test-mini-bundle.mjs [/absolute/mini.app]');
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'lingoweave-bundle-')));
let child;
let output = '';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Bundle validation process exited with ${code}.`));
    });
  });
}

async function verifyRelocatedLinks(directory, service) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const link = await readlink(path);
      assert.equal(isAbsolute(link), false, 'Packaged dependency links must stay relative.');
      const target = resolve(dirname(path), link);
      assert.ok(target.startsWith(service + sep), 'Relocated links must stay inside the service.');
      assert.equal(
        await realpath(path),
        target,
        'Relocated dependency links must resolve locally.',
      );
    } else if (info.isDirectory()) await verifyRelocatedLinks(path, service);
  }
}

try {
  const service = join(temporary, 'moved application', 'service');
  await cp(join(application, 'Contents/Resources/service'), service, {
    recursive: true,
    verbatimSymlinks: true,
  });
  await verifyRelocatedLinks(service, service);
  const node = join(service, 'runtime/node');
  const manifest = JSON.parse(await readFile(join(service, 'runtime-manifest.json'), 'utf8'));
  assert.equal(
    createHash('sha256')
      .update(await readFile(node))
      .digest('hex'),
    manifest.binarySha256,
    'The copied runtime must match its packaged manifest.',
  );
  const profile = `(version 1)(allow default)(deny file-read* (subpath ${JSON.stringify(root.replace(/\/$/, ''))}))`;
  const probe = `import { readFileSync } from 'node:fs';
    try { readFileSync(${JSON.stringify(join(root, 'package.json'))}); process.exit(2); }
    catch (error) { if (error.code !== 'EPERM') throw error; }`;
  await run('/usr/bin/sandbox-exec', ['-p', profile, node, '--input-type=module', '-e', probe], {
    cwd: temporary,
  });

  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const tokenFile = join(temporary, 'token');
  child = spawn(
    '/usr/bin/sandbox-exec',
    ['-p', profile, node, join(service, 'apps/server/dist/index.js')],
    {
      cwd: temporary,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        HOST: '127.0.0.1',
        PORT: String(port),
        DATA_DIR: join(temporary, 'data'),
        MINI_TOKEN_FILE: tokenFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const append = (bytes) => {
    output = (output + bytes.toString()).slice(-100_000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  let spawnError;
  child.once('error', (error) => {
    spawnError = error;
  });
  let snapshot;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(output);
    try {
      const token = (await readFile(tokenFile, 'utf8')).trim();
      const response = await fetch(`http://127.0.0.1:${port}/api/mini/snapshot`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        snapshot = await response.json();
        break;
      }
    } catch {
      /* Wait for the isolated service and its private token. */
    }
    await delay(100);
  }
  assert.ok(snapshot, output);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.imported, false);
  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/mini/snapshot`);
  assert.equal(unauthorized.status, 401);
  process.stdout.write(
    `Relocated bundle served authenticated HTTP with Node ${manifest.version} while repository reads were denied.\n`,
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    for (
      let attempt = 0;
      attempt < 100 && child.exitCode === null && child.signalCode === null;
      attempt++
    )
      await delay(100);
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await stopped;
    }
  }
  await rm(temporary, { recursive: true, force: true });
}
