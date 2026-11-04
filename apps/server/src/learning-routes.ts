import type { FastifyInstance } from 'fastify';
import {
  cancelRequestSchema,
  prepareRequestSchema,
  publishMaterialsSchema,
} from '@lingoweave/contracts';
import { z } from 'zod';
import { LearningError } from './learning-store.js';
import type { PreparationService } from './preparation-service.js';

export function registerLearningRoutes(app: FastifyInstance, service: PreparationService) {
  const streams = new Set<() => void>();
  app.addHook('preClose', async () => {
    for (const close of streams) close();
  });
  app.addHook('onClose', async () => {
    for (const close of streams) close();
    await service.close();
  });

  app.addHook('onRequest', async (request) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    const origin = request.headers.origin;
    if (origin) {
      let sameOrigin = false;
      try {
        const parsed = new URL(origin);
        sameOrigin =
          parsed.protocol === 'http:' &&
          parsed.host === request.headers.host &&
          ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
      } catch {
        /* Invalid Origin is rejected. */
      }
      if (!sameOrigin)
        throw new LearningError('ORIGIN_REJECTED', '请从本机学习页面发起操作。', 403);
    }
  });

  app.get('/api/runtime', async () => service.status());
  app.get('/api/learning', async () => service.store.snapshot());
  app.post('/api/learning/prepare', async (request, reply) => {
    const input = prepareRequestSchema.parse(request.body);
    return reply.code(202).send(service.prepare(input.requestId, input.model));
  });
  app.post('/api/learning/jobs/:id/cancel', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const input = cancelRequestSchema.parse(request.body);
    return service.cancel(id, input.requestId);
  });
  app.post('/api/internal/learning', async (request) => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer '))
      throw new LearningError('UNAUTHORIZED', '缺少学习工具身份。', 401);
    const jobId = service.jobForToken(authorization.slice(7));
    const command = z
      .discriminatedUnion('action', [
        z.object({ action: z.literal('context') }).strict(),
        z.object({ action: z.literal('publish'), input: publishMaterialsSchema }).strict(),
      ])
      .parse(request.body);
    return command.action === 'context'
      ? service.store.toolContext(jobId)
      : service.store.publish(jobId, command.input);
  });

  app.get('/api/learning/events', (request, reply) => {
    const { after } = z
      .object({ after: z.coerce.number().int().nonnegative().default(0) })
      .parse(request.query);
    const cursor = z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(request.headers['last-event-id'] ?? after);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let stopped = false;
    const send = (event: ReturnType<typeof service.store.eventsAfter>[number]) => {
      if (stopped) return;
      if (reply.raw.writableLength > 256_000) {
        close();
        return;
      }
      reply.raw.write(`id: ${event.seq}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = service.store.subscribe(send);
    const heartbeat = setInterval(() => {
      if (!stopped) reply.raw.write(': keep-alive\n\n');
    }, 15_000);
    heartbeat.unref();
    const close = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(close);
      reply.raw.end();
    };
    streams.add(close);
    reply.raw.on('close', close);
    reply.raw.write('retry: 1500\n\n');
    const latest = service.store.snapshot().lastEventSeq;
    // A restored backup may have a lower cursor; instruct the client to re-read its snapshot.
    if (cursor > latest) reply.raw.write(`event: reset\ndata: {}\n\n`);
    for (const event of service.store.eventsAfter(cursor > latest ? 0 : cursor)) send(event);
  });
}
