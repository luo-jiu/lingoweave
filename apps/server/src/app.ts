import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import fastifyStatic from '@fastify/static';
import { type ApiError, type HealthResponse } from '@lingoweave/contracts';
import Fastify from 'fastify';

export interface AppOptions {
  logger?: boolean;
  staticRoot?: string;
}

function errorBody(code: string, message: string, requestId: string): ApiError {
  return { error: { code, message, requestId } };
}

function verifyStaticRoot(staticRoot: string) {
  if (!isAbsolute(staticRoot)) {
    throw new Error('The frontend build directory must be an absolute path.');
  }

  try {
    if (!statSync(join(staticRoot, 'index.html')).isFile()) {
      throw new Error('Missing index.html');
    }
  } catch {
    throw new Error('Frontend build is missing. Run pnpm build before pnpm start.');
  }
}

export function buildApp(options: AppOptions = {}) {
  if (options.staticRoot) verifyStaticRoot(options.staticRoot);

  const app = Fastify({
    logger: options.logger
      ? {
          serializers: {
            req: (request) => ({
              method: request.method,
              url: request.url?.split('?')[0],
            }),
          },
        }
      : false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.get('/api/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: 'lingoweave-api',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  }));

  app.setErrorHandler((error, request, reply) => {
    const errorDetails = typeof error === 'object' && error !== null ? error : {};
    const suppliedStatus = 'statusCode' in errorDetails ? errorDetails.statusCode : undefined;
    const statusCode =
      typeof suppliedStatus === 'number' &&
      Number.isInteger(suppliedStatus) &&
      suppliedStatus >= 400 &&
      suppliedStatus < 600
        ? suppliedStatus
        : 500;
    const diagnosticCode =
      'code' in errorDetails && typeof errorDetails.code === 'string'
        ? errorDetails.code
        : undefined;

    request.log.error({ code: diagnosticCode, statusCode }, 'Request failed');

    const code = statusCode >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST';
    const message = statusCode >= 500 ? 'An internal error occurred.' : 'The request is invalid.';
    void reply.code(statusCode).send(errorBody(code, message, request.id));
  });

  if (options.staticRoot) {
    app.register(fastifyStatic, { root: options.staticRoot });
  }

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0] ?? '/';
    const isApi = pathname === '/api' || pathname.startsWith('/api/');
    const isAsset = pathname.startsWith('/assets/') || pathname.split('/').at(-1)?.includes('.');
    const acceptsHtml = request.headers.accept
      ?.split(',')
      .some((type) => type.trim().startsWith('text/html'));

    if (
      options.staticRoot &&
      !isApi &&
      !isAsset &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      acceptsHtml
    ) {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }

    return reply
      .code(404)
      .send(errorBody('NOT_FOUND', 'The requested resource was not found.', request.id));
  });

  return app;
}
