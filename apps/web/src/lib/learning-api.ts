import {
  apiErrorSchema,
  cancelRequestSchema,
  preparationReceiptSchema,
  prepareRequestSchema,
  runtimeStatusSchema,
  workspaceSnapshotSchema,
} from '@lingoweave/contracts';

interface ResponseSchema<T> {
  parse(value: unknown): T;
}

export class LearningRequestError extends Error {
  constructor(
    message: string,
    readonly definitive = false,
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  schema: ResponseSchema<T>,
  init: RequestInit = {},
): Promise<T> {
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      signal,
      cache: 'no-store',
      headers: { Accept: 'application/json', ...init.headers },
    });
  } catch {
    throw new LearningRequestError('暂时连接不上本地服务，请稍后重试。');
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new LearningRequestError('服务返回了无法识别的内容，请重新确认状态。');
  }

  if (!response.ok) {
    const error = apiErrorSchema.safeParse(payload);
    throw new LearningRequestError(
      error.success ? error.data.error.message : `服务请求未完成（HTTP ${response.status}）。`,
      error.success && [400, 401, 403, 404, 409, 422].includes(response.status),
    );
  }

  try {
    return schema.parse(payload);
  } catch {
    throw new LearningRequestError('服务响应与页面版本不兼容，请刷新页面。');
  }
}

export function getWorkspace(signal?: AbortSignal) {
  return request('/api/learning', workspaceSnapshotSchema, { signal });
}

export function getRuntime(signal?: AbortSignal) {
  return request('/api/runtime', runtimeStatusSchema, { signal });
}

export type PendingAction =
  | { kind: 'prepare'; requestId: string; model?: string }
  | { kind: 'cancel'; requestId: string; jobId: string };

export function parsePendingAction(value: unknown): PendingAction | null {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return null;

  if (value.kind === 'prepare') {
    const result = prepareRequestSchema.safeParse({
      requestId: 'requestId' in value ? value.requestId : undefined,
      model: 'model' in value ? value.model : undefined,
    });
    return result.success ? { kind: 'prepare', ...result.data } : null;
  }

  if (value.kind === 'cancel' && 'jobId' in value && typeof value.jobId === 'string') {
    const result = cancelRequestSchema.safeParse({
      requestId: 'requestId' in value ? value.requestId : undefined,
    });
    return result.success && value.jobId.length > 0
      ? { kind: 'cancel', jobId: value.jobId, ...result.data }
      : null;
  }

  return null;
}

export function sendAction(action: PendingAction) {
  if (action.kind === 'prepare') {
    return request('/api/learning/prepare', preparationReceiptSchema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: action.requestId, model: action.model }),
    });
  }

  return request(
    `/api/learning/jobs/${encodeURIComponent(action.jobId)}/cancel`,
    preparationReceiptSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: action.requestId }),
    },
  );
}
