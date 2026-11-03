import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { parseConfig } from './config.js';

try {
  loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
    throw error;
  }
}

const config = parseConfig(process.env);
const app = buildApp({
  logger: true,
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
  await app.listen({ host: config.host, port: config.port });
} catch {
  app.log.error({ host: config.host, port: config.port }, 'Server could not start');
  process.exitCode = 1;
  await app.close();
}
