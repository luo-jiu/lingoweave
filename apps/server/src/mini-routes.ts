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
  miniTranslationReviewQuerySchema,
  miniMemoryOverviewInputSchema,
  miniMemoryDetailInputSchema,
  miniPatternQuerySchema,
  miniPatternPracticeSchema,
  miniPatternViewSchema,
  miniPhraseQuerySchema,
} from '@lingoweave/contracts';
import type { FastifyInstance } from 'fastify';
import { LearningError } from './learning-store.js';
import type { MiniStore } from './mini-store.js';
import type { MiniAiService } from './mini-ai-service.js';
import type { MiniAudioService } from './mini-audio-service.js';
import { pendingMeaningComment } from './mini-translation-review.js';
import { miniWordProgress, type MiniVocabularyStore } from './mini-vocabulary-store.js';
import type { MiniAssessmentService } from './mini-assessment-service.js';
import { z } from 'zod';
import { withoutMiniPlanMinutes } from './mini-plan-migration.js';
import { memoryOverview, memoryDetail } from './mini-memory.js';
import { miniDataOverview } from './mini-data-overview.js';

export interface MiniRouteOptions {
  store: MiniStore;
  token: string;
  ai?: MiniAiService;
  audio?: MiniAudioService;
  vocabulary?: MiniVocabularyStore;
  assessment?: MiniAssessmentService;
  dataDirectory?: string;
  serviceLog?: string;
}

export function registerMiniRoutes(app: FastifyInstance, options: MiniRouteOptions) {
  const { store, token, ai, audio, vocabulary, assessment, dataDirectory, serviceLog } = options;
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
    mini.get('/api/mini/translations/review', async (request) => {
      const query = miniTranslationReviewQuerySchema.parse(request.query);
      const report = store.translationReview(
        query,
        (id) => assessment?.store.translationReview(id) ?? null,
      );
      return (
        assessment?.expressions.display(report) ?? {
          ...report,
          entries: report.entries.map(pendingMeaningComment),
        }
      );
    });
    if (assessment) {
      mini.post('/api/mini/translations/review/grade-missing', async (request) => {
        const query = miniTranslationReviewQuerySchema.parse(request.body);
        const report = store.translationReview(query, (id) =>
          assessment.store.translationReview(id),
        );
        return assessment.expressions.enqueue(report, (id) => store.translationModel(id));
      });
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
    if (dataDirectory)
      mini.get('/api/mini/data-overview', async (_request, reply) => {
        reply.header('cache-control', 'private, no-store');
        return miniDataOverview({
          store,
          dataDirectory,
          serviceLog,
          ai: ai?.store,
          audio: audio?.store,
          assessment: assessment?.store,
          vocabulary,
        });
      });
    mini.get('/api/mini/snapshot', async () => store.snapshot());
    mini.get('/api/mini/phrases', async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const query = miniPhraseQuerySchema.parse(request.query);
      return store.phrases(
        query,
        query.kind === 'pattern' ? undefined : audio?.store.heardSentences(),
      );
    });
    mini.post('/api/mini/patterns/view', async (request) =>
      store.viewPattern(miniPatternViewSchema.parse(request.body)),
    );
    mini.get('/api/mini/patterns', async (request) =>
      store.patterns(miniPatternQuerySchema.parse(request.query).timezone),
    );
    mini.post('/api/mini/patterns/practice', async (request) =>
      store.practicePattern(miniPatternPracticeSchema.parse(request.body)),
    );
    mini.post('/api/mini/plan-preview', async (request) => {
      const input = miniPlanPreviewInputSchema.parse(request.body);
      const preview = store.planPreview(input);
      preview.planContext.wordProgress = miniWordProgress(
        preview.ledger,
        input.deck,
        vocabulary?.activeBookIndex(),
      );
      return preview;
    });
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
