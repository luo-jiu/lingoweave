import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { parseConfig } from './config.js';
import { LearningStore } from './learning-store.js';
import { PreparationService } from './preparation-service.js';
import { CodexBridge } from './codex/bridge.js';
import { seedWords } from './seed.js';

try {
  loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
    throw error;
  }
}

const config = parseConfig(process.env);
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const dataDirectory = resolve(projectRoot, config.dataDir);
const agentWorkspace = resolve(dataDirectory, 'agent-workspace');
const store = new LearningStore(resolve(dataDirectory, 'lingoweave.sqlite'), seedWords);
const learning = new PreparationService(
  store,
  new CodexBridge({ executable: config.codexBin, cwd: agentWorkspace }),
  agentWorkspace,
);
const app = buildApp({
  logger: true,
  learning,
  ...(config.nodeEnv === 'production'
    ? { staticRoot: fileURLToPath(new URL('../../web/dist/', import.meta.url)) }
    : {}),
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Shutting down');

  try {
    await app.close();
  } catch {
    app.log.error('Shutdown failed');
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  const address = await app.listen({ host: config.host, port: config.port });
  learning.setBaseUrl(address);
} catch {
  app.log.error({ host: config.host, port: config.port }, 'Server could not start');
  process.exitCode = 1;
  await app.close();
}
