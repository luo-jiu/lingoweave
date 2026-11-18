import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile, open, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
if (args.some((arg) => !['--dev', '--stop'].includes(arg))) {
  throw new Error('Usage: node scripts/mini-service.mjs [--dev] [--stop]');
}
const development = args.includes('--dev');
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(
  homedir(),
  'Library',
  'Application Support',
  development ? 'com.lingoweave.mini.dev' : 'com.lingoweave.mini',
  'service',
);
const tokenFile = join(directory, 'token');
const metadataFile = join(directory, 'process.json');
const entry = join(root, 'apps/server/dist/index.js');
const port = development ? 4311 : 4312;
const address = `http://127.0.0.1:${port}`;

async function codexExecutable() {
  if (process.env.CODEX_BIN?.trim()) return process.env.CODEX_BIN.trim();
  const bundled = [
    '/Applications/Codex.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    join(homedir(), 'Applications/Codex.app/Contents/Resources/codex'),
  ];
  for (const candidate of bundled) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Try the next installed runtime. */
    }
  }
  return 'codex';
}
const codexBin = await codexExecutable();

function proxyEnvironment() {
  if (
    process.platform !== 'darwin' ||
    ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'].some(
      (key) => process.env[key],
    )
  )
    return {};
  try {
    const values = Object.fromEntries(
      [
        ...execFileSync('/usr/sbin/scutil', ['--proxy'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).matchAll(/^\s*(\w+)\s*:\s*(\S+)\s*$/gm),
      ].map((match) => [match[1], match[2]]),
    );
    const proxy = (prefix) =>
      values[`${prefix}Enable`] === '1' &&
      values[`${prefix}Proxy`] &&
      /^\d+$/.test(values[`${prefix}Port`] ?? '')
        ? `http://${values[`${prefix}Proxy`]}:${values[`${prefix}Port`]}`
        : undefined;
    const http = proxy('HTTP'),
      https = proxy('HTTPS') ?? http;
    return {
      ...(http ? { HTTP_PROXY: http } : {}),
      ...(https ? { HTTPS_PROXY: https } : {}),
      NO_PROXY: '127.0.0.1,localhost',
    };
  } catch {
    return {};
  }
}
const proxies = proxyEnvironment();

async function buildFingerprint() {
  const hash = createHash('sha256')
    .update(process.execPath)
    .update(process.version)
    .update(codexBin)
    .update(JSON.stringify(proxies));
  hash.update(await readFile(fileURLToPath(import.meta.url)));
  hash.update(process.env.MINI_TTS_ROOT ?? join(homedir(), 'sdks/lingoweave-tts'));
  hash.update(await readFile(join(root, 'scripts/mini-tts-worker.py')));
  try {
    hash.update(await readFile(join(root, 'runtime-manifest.json')));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const skills = join(root, 'skills');
  for (const file of (await readdir(skills, { recursive: true }))
    .filter((file) => file.endsWith('.md'))
    .sort())
    hash.update(file).update(await readFile(join(skills, file)));
  try {
    hash.update(await readFile(join(root, '.env')));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const directory of ['apps/server/dist', 'packages/contracts/dist']) {
    const base = join(root, directory);
    const files = (await readdir(base, { recursive: true }))
      .filter((file) => file.endsWith('.js'))
      .sort();
    for (const file of files) {
      hash.update(`${directory}/${file}\0`).update(await readFile(join(base, file)));
    }
  }
  return hash.digest('hex');
}

async function currentBuild(fingerprint) {
  try {
    const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
    return (
      metadata.entry === entry &&
      metadata.address === address &&
      metadata.buildFingerprint === fingerprint &&
      ownsPort(metadata.pid)
    );
  } catch {
    return false;
  }
}

async function ready() {
  try {
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) return false;
    const response = await fetch(`${address}/api/mini/snapshot`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(700),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body.schemaVersion === 1 && Number.isInteger(body.revision);
  } catch {
    return false;
  }
}

function ownsPort(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    const listeners = execFileSync(
      '/usr/sbin/lsof',
      ['-nP', '-a', '-p', String(pid), `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-Fp'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return listeners.split('\n').includes(`p${pid}`);
  } catch {
    return false;
  }
}

async function stopUnlocked() {
  let metadata;
  try {
    metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (
    !Number.isInteger(metadata.pid) ||
    metadata.pid <= 1 ||
    typeof metadata.entry !== 'string' ||
    !isAbsolute(metadata.entry) ||
    !metadata.entry.endsWith('/apps/server/dist/index.js') ||
    metadata.address !== address
  ) {
    throw new Error('Invalid mini service process record.');
  }
  let command;
  try {
    command = execFileSync('/bin/ps', ['-p', String(metadata.pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    await rm(metadataFile, { force: true });
    return;
  }
  if (!command.includes(metadata.entry) || !ownsPort(metadata.pid) || !(await ready())) {
    throw new Error('Cannot verify this mini service process; no process was stopped.');
  }
  process.kill(metadata.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(metadata.pid, 0);
    } catch {
      await rm(metadataFile, { force: true });
      return;
    }
    await delay(100);
  }
  throw new Error('Mini service has not stopped yet.');
}

async function withLauncherLock(operation) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, 'start.lock');
  const owner = randomUUID();
  let ownsLock = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lock);
      ownsLock = true;
      try {
        await writeFile(join(lock, 'pid'), String(process.pid), { mode: 0o600 });
        await writeFile(join(lock, 'owner'), owner, { mode: 0o600 });
      } catch (error) {
        await rm(lock, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const identity = await readFile(join(lock, 'pid'), 'utf8');
        const priorOwner = await readFile(join(lock, 'owner'), 'utf8').catch(() => '');
        const pid = Number(identity);
        if (!Number.isInteger(pid) || pid <= 1) {
          throw new Error('Incomplete launcher identity.', { cause: error });
        }
        try {
          process.kill(pid, 0);
        } catch (probe) {
          if (
            probe?.code === 'ESRCH' &&
            (await readFile(join(lock, 'pid'), 'utf8')) === identity &&
            (await readFile(join(lock, 'owner'), 'utf8').catch(() => '')) === priorOwner
          )
            await rm(lock, { recursive: true, force: true });
        }
      } catch {
        // Recover a launcher that crashed between creating its lock and writing its identity.
        try {
          const previous = await stat(lock);
          if (Date.now() - previous.mtimeMs > 5_000) {
            const identity = await readFile(join(lock, 'pid'), 'utf8').catch(() => '');
            const pid = Number(identity);
            if ((!Number.isInteger(pid) || pid <= 1) && (await stat(lock)).ino === previous.ino) {
              await rm(lock, { recursive: true, force: true });
            }
          }
        } catch {
          // Another launcher may already have recovered this lock.
        }
      }
      await delay(100);
    }
  }
  if (!ownsLock) throw new Error('Another mini service launcher is still starting.');
  try {
    return await operation();
  } finally {
    if ((await readFile(join(lock, 'owner'), 'utf8').catch(() => '')) === owner)
      await rm(lock, { recursive: true, force: true });
  }
}

async function start() {
  const fingerprint = await buildFingerprint();
  if ((await ready()) && (await currentBuild(fingerprint))) return;
  return withLauncherLock(async () => {
    if ((await ready()) && (await currentBuild(fingerprint))) return;
    if (await ready()) {
      await stopUnlocked();
      if (await ready()) {
        throw new Error('A previous mini service is running without a verifiable process record.');
      }
    }
    const log = await open(join(directory, 'service.log'), 'a', 0o600);
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: {
        ...process.env,
        ...proxies,
        CODEX_BIN: codexBin,
        NODE_ENV: 'development',
        HOST: '127.0.0.1',
        PORT: String(port),
        DATA_DIR: join(directory, 'data'),
        MINI_TOKEN_FILE: tokenFile,
      },
    });
    let failure;
    child.on('error', (error) => {
      failure = error;
    });
    child.on('exit', (code) => {
      failure = new Error(`Mini service exited (${code}).`);
    });
    child.unref();
    await log.close();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (failure) throw failure;
      if ((await ready()) && ownsPort(child.pid)) {
        await writeFile(
          metadataFile,
          JSON.stringify({ pid: child.pid, entry, address, buildFingerprint: fingerprint }),
          { mode: 0o600 },
        );
        return;
      }
      await delay(100);
    }
    if (child.pid) child.kill('SIGTERM');
    throw new Error(`Mini service did not become ready. Check ${join(directory, 'service.log')}.`);
  });
}

try {
  if (args.includes('--stop')) await withLauncherLock(stopUnlocked);
  else await start();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Mini service failed.'}\n`);
  process.exitCode = 1;
}
