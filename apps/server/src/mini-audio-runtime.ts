import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { MiniAudioRuntime, MiniAudioVoice } from '@lingoweave/contracts';
import { LearningError } from './learning-store.js';

const generationParametersSchema = z
  .object({
    kind: z.enum(['word', 'sentence']),
    temperature: z.number().finite().min(0).max(2),
    maxTokens: z.number().int().min(1).max(8192),
    maximumDurationSeconds: z.number().finite().min(0.1).max(120),
  })
  .strict();
export type MiniTtsGenerationParameters = z.infer<typeof generationParametersSchema>;
export interface MiniTtsGenerationInput {
  text: string;
  voice: MiniAudioVoice;
  instructions: string;
  outputFile: string;
  signal: AbortSignal;
  parameters?: MiniTtsGenerationParameters;
}
export interface MiniTtsRuntime {
  status(): Promise<MiniAudioRuntime>;
  generate(input: MiniTtsGenerationInput): Promise<void>;
  close(): Promise<void>;
}
const manifestSchema = z.object({
  repository: z.string(),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  directory: z.string(),
  files: z
    .array(
      z.object({
        path: z.string(),
        size: z.number().int().positive(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(1),
});
const installationSchema = z.object({ mlx_audio: z.string(), mlx: z.string() });
const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), engineVersion: z.string() }),
  z.object({ type: z.literal('complete'), id: z.string() }),
  z.object({ type: z.literal('error'), code: z.string() }),
]);
type WorkerEvent = z.infer<typeof eventSchema>;
function unavailable() {
  return new LearningError('TTS_UNAVAILABLE', '本地语音环境不可用，已有音频仍可播放。', 503);
}
function runtimeFailure() {
  return new LearningError(
    'TTS_GENERATION_FAILED',
    '本地音频生成中断，已有音频保留，可以重试。',
    503,
  );
}

export class LocalMiniTtsRuntime implements MiniTtsRuntime {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private reader = '';
  private readonly listeners = new Set<(event: WorkerEvent) => void>();
  private readonly failures = new Set<(error: Error) => void>();
  private configurationFingerprint: string | null = null;
  private closing = false;
  private generating = false;
  constructor(
    readonly root: string,
    private readonly options: { idleMs?: number; timeoutMs?: number } = {},
  ) {}
  private async configuration() {
    const [manifestRaw, installationRaw] = await Promise.all([
      readFile(join(this.root, 'model-manifest.json'), 'utf8'),
      readFile(join(this.root, 'installation.json'), 'utf8'),
    ]);
    const manifest = manifestSchema.parse(JSON.parse(manifestRaw)),
      installation = installationSchema.parse(JSON.parse(installationRaw));
    const base = resolve(this.root),
      model = resolve(base, manifest.directory);
    if (!model.startsWith(`${base}${sep}`)) throw unavailable();
    await access(join(base, 'runtime/bin/python'), constants.X_OK);
    for (const file of manifest.files) {
      const path = resolve(model, file.path);
      if (!path.startsWith(`${model}${sep}`)) throw unavailable();
      const info = await stat(path);
      if (!info.isFile() || info.size !== file.size) throw unavailable();
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ manifest, installation, model }))
      .digest('hex');
    if (this.configurationFingerprint && this.configurationFingerprint !== fingerprint)
      throw unavailable();
    this.configurationFingerprint = fingerprint;
    return { manifest, installation, model };
  }
  async status(): Promise<MiniAudioRuntime> {
    try {
      const { manifest, installation } = await this.configuration();
      return {
        available: true,
        profile: {
          modelId: manifest.repository,
          modelRevision: manifest.revision,
          engine: 'mlx-audio',
          engineVersion: `${installation.mlx_audio}/mlx-${installation.mlx}`,
          generationVersion: 'mini-audio-1',
          language: 'English',
          temperature: 0.7,
          maxTokens: 2048,
        },
        error: null,
      };
    } catch {
      return { available: false, profile: null, error: '本地语音环境尚未就绪；已有缓存仍可播放。' };
    }
  }
  private fail(error: Error) {
    for (const listener of this.failures) listener(error);
    this.listeners.clear();
    this.failures.clear();
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Already gone. */
      }
    }
  }
  private waitFor(predicate: (event: WorkerEvent) => boolean, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.listeners.delete(event);
        this.failures.delete(failed);
        signal?.removeEventListener('abort', aborted);
        if (error) reject(error);
        else resolve();
      };
      const failed = (error: Error) => finish(error);
      const aborted = () => {
        this.fail(runtimeFailure());
        finish(runtimeFailure());
      };
      const event = (value: WorkerEvent) => {
        if (value.type === 'error')
          finish(
            value.code === 'TTS_BUSY'
              ? new LearningError('TTS_BUSY', '另一实例正在使用本地语音，请稍后重试。', 503)
              : value.code === 'TTS_WORD_INVALID'
                ? new LearningError('TTS_WORD_INVALID', '单词音频未通过检查，可以重新生成。', 503)
                : runtimeFailure(),
          );
        else if (predicate(value)) finish();
      };
      const timer = setTimeout(() => {
        this.fail(runtimeFailure());
        finish(runtimeFailure());
      }, this.options.timeoutMs ?? 180_000);
      this.listeners.add(event);
      this.failures.add(failed);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }
  private async start(signal: AbortSignal) {
    if (this.closing || signal.aborted) throw unavailable();
    const { manifest, installation, model } = await this.configuration();
    if (this.child && this.ready) return this.ready;
    for (const file of manifest.files) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(join(model, file.path))) {
        if (signal.aborted || this.closing) throw runtimeFailure();
        hash.update(chunk);
      }
      if (hash.digest('hex') !== file.sha256) throw unavailable();
    }
    if (signal.aborted || this.closing) throw runtimeFailure();
    const cache = join(this.root, 'cache');
    await mkdir(join(cache, 'tmp'), { recursive: true, mode: 0o700 });
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
      HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
      XDG_CACHE_HOME: join(cache, 'xdg'),
      XDG_CONFIG_HOME: join(cache, 'config'),
      XDG_DATA_HOME: join(cache, 'data'),
      HF_HOME: join(cache, 'huggingface'),
      HF_HUB_CACHE: join(cache, 'huggingface/hub'),
      HF_XET_CACHE: join(cache, 'huggingface/xet'),
      HF_ASSETS_CACHE: join(cache, 'huggingface/assets'),
      HF_TOKEN_PATH: join(cache, 'huggingface/token'),
      TORCH_HOME: join(cache, 'torch'),
      MPLCONFIGDIR: join(cache, 'matplotlib'),
      NUMBA_CACHE_DIR: join(cache, 'numba'),
      TMPDIR: join(cache, 'tmp'),
    };
    delete environment.OPENAI_API_KEY;
    delete environment.CODEX_API_KEY;
    const child = spawn(
      join(this.root, 'runtime/bin/python'),
      [
        '-u',
        fileURLToPath(new URL('../../../scripts/mini-tts-worker.py', import.meta.url)),
        this.root,
        String((this.options.idleMs ?? 30_000) / 1000),
      ],
      { cwd: this.root, env: environment, stdio: ['pipe', 'pipe', 'pipe'], detached: true },
    );
    this.child = child;
    this.reader = '';
    child.stderr.on('data', () => {});
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child) return;
      this.reader += chunk.toString('utf8');
      if (Buffer.byteLength(this.reader) > 65536) {
        this.fail(runtimeFailure());
        return;
      }
      let position: number;
      while ((position = this.reader.indexOf('\n')) >= 0) {
        const line = this.reader.slice(0, position);
        this.reader = this.reader.slice(position + 1);
        if (!line.trim()) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          this.fail(runtimeFailure());
          return;
        }
        const parsed = eventSchema.safeParse(value);
        if (!parsed.success) {
          this.fail(runtimeFailure());
          return;
        }
        if (
          parsed.data.type === 'ready' &&
          parsed.data.engineVersion !== `${installation.mlx_audio}/mlx-${installation.mlx}`
        ) {
          this.fail(unavailable());
          return;
        }
        for (const listener of [...this.listeners]) listener(parsed.data);
      }
    });
    child.stdin.on('error', () => {
      if (this.child === child) this.fail(runtimeFailure());
    });
    child.on('error', () => {
      if (this.child === child) this.fail(unavailable());
    });
    child.on('close', () => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      for (const listener of [...this.failures]) listener(runtimeFailure());
      this.listeners.clear();
      this.failures.clear();
    });
    this.ready = this.waitFor((event) => event.type === 'ready', signal);
    return this.ready;
  }
  async generate(input: MiniTtsGenerationInput) {
    if (this.generating) throw new LearningError('TTS_BUSY', '本地语音正在处理另一任务。', 503);
    if (input.signal.aborted) throw runtimeFailure();
    const parameters = input.parameters
      ? generationParametersSchema.parse(input.parameters)
      : undefined;
    this.generating = true;
    try {
      await this.start(input.signal);
      if (input.signal.aborted) throw runtimeFailure();
      const child = this.child;
      if (!child) throw runtimeFailure();
      const id = randomUUID();
      const completion = this.waitFor(
        (event) => event.type === 'complete' && event.id === id,
        input.signal,
      );
      child.stdin.write(
        `${JSON.stringify({ type: 'generate', id, text: input.text, voice: input.voice, instructions: input.instructions, outputFile: input.outputFile, ...(parameters ? { parameters } : {}) })}\n`,
      );
      await completion;
    } finally {
      this.generating = false;
    }
  }
  async close() {
    this.closing = true;
    this.fail(new LearningError('TTS_CLOSED', '本地语音服务正在关闭。', 503));
  }
}
