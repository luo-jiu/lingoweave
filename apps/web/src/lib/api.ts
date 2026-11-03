import { healthResponseSchema, type HealthResponse } from '@lingoweave/contracts';

export async function getHealth(signal: AbortSignal): Promise<HealthResponse> {
  const response = await fetch('/api/health', {
    signal,
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`服务暂时不可用（HTTP ${response.status}）。`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('服务返回了无法识别的内容。');
  }

  const result = healthResponseSchema.safeParse(payload);
  if (!result.success) {
    throw new Error('服务响应与当前版本不兼容。');
  }

  return result.data;
}
