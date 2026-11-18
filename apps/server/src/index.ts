import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { parseConfig } from './config.js';
import { LearningStore } from './learning-store.js';
import { PreparationService } from './preparation-service.js';
import { CodexBridge } from './codex/bridge.js';
import { seedWords } from './seed.js';
import { MiniStore } from './mini-store.js';
import { MiniAiStore } from './mini-ai-store.js';
import { MiniAiService } from './mini-ai-service.js';
import { loadMiniToken } from './mini-token.js';
import { MiniAudioStore } from './mini-audio-store.js';
import { MiniAudioService } from './mini-audio-service.js';
import { LocalMiniTtsRuntime } from './mini-audio-runtime.js';
import { MiniVocabularyStore } from './mini-vocabulary-store.js';
import { MiniMaterialLibrary } from './mini-materials.js';
import { MiniAssessmentStore } from './mini-assessment-store.js';
import { MiniAssessmentService } from './mini-assessment-service.js';

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
const miniStore = config.miniTokenFile
  ? new MiniStore(resolve(dataDirectory, 'mini.sqlite'))
  : null;
const miniAudio = miniStore
  ? new MiniAudioService(
      miniStore,
      new MiniAudioStore(resolve(dataDirectory, 'mini-audio.sqlite')),
      new LocalMiniTtsRuntime(resolve(projectRoot, config.miniTtsRoot)),
      { directory: resolve(dataDirectory, 'audio') },
    )
  : null;
const miniVocabulary = miniStore
  ? new MiniVocabularyStore(resolve(dataDirectory, 'mini-vocabulary.sqlite'))
  : null;
const miniAi = miniStore
  ? new MiniAiService(
      miniStore,
      new MiniAiStore(resolve(dataDirectory, 'mini-ai.sqlite')),
      new CodexBridge({
        executable: config.codexBin,
        cwd: resolve(dataDirectory, 'mini-agent-workspace'),
        turnTimeoutMs: 360_000,
      }),
      miniAudio ?? undefined,
      miniVocabulary ?? undefined,
      new MiniMaterialLibrary(resolve(dataDirectory, 'materials')),
    )
  : null;
if (miniStore && miniAi) {
  miniStore.setAssessmentDiscussionProvider((word, submittedAt, confirmedAt) =>
    miniAi.store.discussionForAssessment(word, submittedAt, confirmedAt),
  );
}
const miniAssessment = miniStore
  ? new MiniAssessmentService(
      {
        pending: () => miniStore.pendingAssessments(),
        get: (id) => miniStore.assessmentSource(id),
        apply: (application) => miniStore.applyAssessment(application),
      },
      new MiniAssessmentStore(resolve(dataDirectory, 'mini-ai.sqlite')),
      new CodexBridge({
        executable: config.codexBin,
        cwd: resolve(dataDirectory, 'mini-assessment-workspace'),
        turnTimeoutMs: 360_000,
      }),
    )
  : null;
const app = buildApp({
  logger: true,
  learning,
  ...(config.miniTokenFile && miniStore && miniAi
    ? {
        mini: {
          store: miniStore,
          ai: miniAi,
          ...(miniAssessment ? { assessment: miniAssessment } : {}),
          ...(miniAudio ? { audio: miniAudio } : {}),
          ...(miniVocabulary ? { vocabulary: miniVocabulary } : {}),
          token: loadMiniToken(resolve(projectRoot, config.miniTokenFile)),
        },
      }
    : {}),
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
  miniAi?.setBaseUrl(address);
  miniAssessment?.setBaseUrl(address);
} catch {
  app.log.error({ host: config.host, port: config.port }, 'Server could not start');
  process.exitCode = 1;
  await app.close();
}
