import { z } from 'zod';
import { homedir } from 'node:os';
import { join } from 'node:path';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  DATA_DIR: z.string().trim().min(1).default('data'),
  CODEX_BIN: z.string().trim().min(1).default('codex'),
  MINI_TOKEN_FILE: z.string().trim().min(1).optional(),
  MINI_TTS_ROOT: z
    .string()
    .trim()
    .min(1)
    .default(join(homedir(), 'sdks', 'lingoweave-tts')),
  PORT: z
    .string()
    .regex(/^\d+$/, 'must be an integer between 1 and 65535')
    .default('4310')
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535)),
});

export function parseConfig(environment: Record<string, string | undefined>) {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid server configuration: ${details}`);
  }

  return {
    nodeEnv: result.data.NODE_ENV,
    host: result.data.HOST,
    port: result.data.PORT,
    dataDir: result.data.DATA_DIR,
    codexBin: result.data.CODEX_BIN,
    miniTtsRoot: result.data.MINI_TTS_ROOT,
    ...(result.data.MINI_TOKEN_FILE ? { miniTokenFile: result.data.MINI_TOKEN_FILE } : {}),
  };
}

export type ServerConfig = ReturnType<typeof parseConfig>;
