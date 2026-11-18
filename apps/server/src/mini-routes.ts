import { timingSafeEqual } from 'node:crypto';
import {
  miniCommandSchema,
  miniImportSchema,
  miniPlanPreviewInputSchema,
  miniAiStartSchema,
  miniAiControlSchema,
  miniAiImportSchema,
  miniAiClearSchema,
  miniAudioRequestSchema,
  miniAudioPlaybackSchema,
  miniAudioPlaybackStartSchema,
  miniVocabularyImportSchema,
  miniVocabularyActivateSchema,
  miniAssessmentRetrySchema,
  miniMemoryOverviewInputSchema,
  miniMemoryDetailInputSchema,
} from '@lingoweave/contracts';
import type { FastifyInstance } from 'fastify';
import { LearningError } from './learning-store.js';
import type { MiniStore } from './mini-store.js';
import type { MiniAiService } from './mini-ai-service.js';
import type { MiniAudioService } from './mini-audio-service.js';
import type { MiniVocabularyStore } from './mini-vocabulary-store.js';
import type { MiniAssessmentService } from './mini-assessment-service.js';
import { z } from 'zod';
import { withoutMiniPlanMinutes } from './mini-plan-migration.js';
import { memoryOverview, memoryDetail } from './mini-memory.js';

export function registerMiniRoutes(
  app: FastifyInstance,
  store: MiniStore,
  token: string,
  ai?: MiniAiService,
  audio?: MiniAudioService,
  vocabulary?: MiniVocabularyStore,
  assessment?: MiniAssessmentService,
) {
  if (token.length < 32) throw new Error('The mini API token must contain at least 32 characters.');
  app.addHook('onClose', async () => {
    if (assessment) await assessment.close();
    if (ai) await ai.close();
    if (audio) await audio.close();
    if (vocabulary) vocabulary.close();
    store.close();
  });
  if (assessment)
    app.post('/api/internal/mini-assessment/:jobId', async (request) => {
      if (request.headers.origin !== undefined)
        throw new LearningError('ORIGIN_REJECTED', '请使用本机学习服务。', 403);
      const { jobId } = z.object({ jobId: z.uuid() }).parse(request.params);
      const body = z
        .object({ action: z.enum(['context', 'commit']), input: z.unknown().optional() })
        .strict()
        .parse(request.body);
      const taskToken = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      return assessment.tool(jobId, taskToken, body.action, body.input);
    });
  if (ai)
    app.post('/api/internal/mini-ai/:jobId', async (request) => {
      if (request.headers.origin !== undefined)
        throw new LearningError('ORIGIN_REJECTED', '请使用本机学习服务。', 403);
      const { jobId } = z.object({ jobId: z.uuid() }).parse(request.params);
      const body = z
        .object({
          action: z.enum(['context', 'history', 'word', 'commit', 'audio_status', 'audio_request']),
          input: z.unknown().optional(),
        })
        .strict()
        .parse(request.body);
      const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      return ai.tool(jobId, token, body.action, body.input);
    });
  app.register(async (mini) => {
    mini.addHook('onRequest', async (request) => {
      if (request.headers.origin !== undefined)
        throw new LearningError('ORIGIN_REJECTED', '请通过本机 mini 窗口访问学习记录。', 403);
      const supplied = request.headers.authorization;
      const expected = Buffer.from(`Bearer ${token}`);
      const actual = Buffer.from(supplied ?? '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        throw new LearningError('UNAUTHORIZED', '缺少或无效的 mini 学习服务身份。', 401);
    });
    if (assessment) {
      mini.get('/api/mini/assessments/snapshot', async () => assessment.snapshot());
      mini.get('/api/mini/assessments/:id', async (request) =>
        assessment.detail(z.object({ id: z.uuid().toLowerCase() }).parse(request.params).id),
      );
      mini.post('/api/mini/assessments/retry', async (request) =>
        assessment.retry(miniAssessmentRetrySchema.parse(request.body)),
      );
    }
    if (ai) {
      mini.get('/api/mini/ai/runtime', async () => ai.status());
      mini.get('/api/mini/ai/snapshot', async () => ai.snapshot());
      mini.get('/api/mini/ai/jobs/:id', async (request) =>
        ai.store.job(z.object({ id: z.uuid() }).parse(request.params).id),
      );
      mini.post('/api/mini/ai/start', async (request) =>
        ai.start(miniAiStartSchema.parse(request.body)),
      );
      mini.post('/api/mini/ai/cancel', async (request) =>
        ai.cancel(miniAiControlSchema.parse(request.body)),
      );
      mini.post('/api/mini/ai/retry', async (request) =>
        ai.retry(miniAiControlSchema.parse(request.body)),
      );
      mini.post('/api/mini/ai/import', async (request) =>
        ai.store.importLegacy(miniAiImportSchema.parse(request.body)),
      );
      mini.post('/api/mini/ai/clear', async (request) =>
        ai.clear(miniAiClearSchema.parse(request.body)),
      );
    }
    if (audio) {
      mini.get('/api/mini/audio/runtime', async () => audio.status());
      mini.get('/api/mini/audio/snapshot', async () => audio.snapshot());
      mini.get('/api/mini/audio/jobs/:id', async (request) =>
        audio.job(z.object({ id: z.uuid().toLowerCase() }).parse(request.params).id),
      );
      mini.post('/api/mini/audio/request', async (request) =>
        audio.request(miniAudioRequestSchema.parse(request.body)),
      );
      mini.get('/api/mini/audio/assets/:id/file', async (request, reply) => {
        const result = await audio.file(
          z.object({ id: z.uuid().toLowerCase() }).parse(request.params).id,
        );
        return reply
          .header('cache-control', 'private, no-store')
          .header('content-length', result.asset.bytes)
          .type('audio/wav')
          .send(result.data);
      });
      mini.post('/api/mini/audio/playback', async (request) =>
        audio.authorize(miniAudioPlaybackSchema.parse(request.body)),
      );
      mini.post('/api/mini/audio/playback/started', async (request) =>
        audio.started(miniAudioPlaybackStartSchema.parse(request.body)),
      );
    }
    if (vocabulary) {
      mini.get('/api/mini/vocabulary/catalog', async () => vocabulary.snapshot());
      mini.post('/api/mini/vocabulary/import', { bodyLimit: 16 * 1024 * 1024 }, async (request) =>
        vocabulary.import(miniVocabularyImportSchema.parse(request.body)),
      );
      mini.post('/api/mini/vocabulary/activate', async (request) =>
        vocabulary.activate(miniVocabularyActivateSchema.parse(request.body)),
      );
    }
    mini.post('/api/mini/memory/overview', async (request) =>
      memoryOverview(store.snapshot(), miniMemoryOverviewInputSchema.parse(request.body)),
    );
    mini.post('/api/mini/memory/detail', async (request) =>
      memoryDetail(store.snapshot(), miniMemoryDetailInputSchema.parse(request.body)),
    );
    mini.get('/api/mini/snapshot', async () => store.snapshot());
    mini.post('/api/mini/plan-preview', async (request) =>
      store.planPreview(miniPlanPreviewInputSchema.parse(request.body)),
    );
    mini.post('/api/mini/import', async (request) =>
      store.importLegacy(miniImportSchema.parse(request.body)),
    );
    mini.post('/api/mini/commands', async (request) => {
      const saved = store.command(miniCommandSchema.parse(withoutMiniPlanMinutes(request.body)));
      // The learning transaction already contains the durable assessment outbox.
      // A wake-up failure must not turn an acknowledged learner action into a failure.
      try {
        assessment?.wake();
      } catch {
        request.log.error('Background assessment wake-up failed');
      }
      return saved;
    });
  });
}
