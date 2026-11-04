import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';

const messageSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).passthrough().optional(),
});

export class CodexError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CodexError';
  }
}

export function cancelledError() {
  return new CodexError('CODEX_CANCELLED', '备课已停止，可以重新准备。');
}

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export interface TransportOptions {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  maxLineBytes?: number;
}

/** JSONL framing and process ownership, independent of teaching/application state. */
export class CodexTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications = new Set<(method: string, params: unknown) => void>();
  private readonly failures = new Set<(error: Error) => void>();
  private readonly decoder = new StringDecoder('utf8');
  private sequence = 0;
  private buffer = '';
  private failure: Error | null = null;
  private closing: Promise<void> | null = null;
  private exited = false;
  private readonly detached = process.platform !== 'win32';

  constructor(private readonly options: TransportOptions) {
    this.child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: this.detached,
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.read(chunk));
    // Drain diagnostics, but never forward credentials, provider URLs or internal logs.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => {
      this.fail(new CodexError('CODEX_DISCONNECTED', 'Codex 连接已中断，请重试备课。'));
    });
    this.child.on('error', () => {
      this.fail(
        new CodexError('CODEX_UNAVAILABLE', '无法启动 Codex，请确认安装路径和本机登录状态。'),
      );
    });
    this.child.on('close', () => {
      this.exited = true;
      this.fail(new CodexError('CODEX_DISCONNECTED', 'Codex 进程已退出，请重试备课。'));
    });
  }

  onNotification(listener: (method: string, params: unknown) => void) {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  onFailure(listener: (error: Error) => void) {
    if (this.failure) listener(this.failure);
    else this.failures.add(listener);
    return () => this.failures.delete(listener);
  }

  request(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs ?? 20_000) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new CodexError('CODEX_TIMEOUT', 'Codex 响应超时，请检查连接后重试。'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    if (this.failure) throw this.failure;
    this.write({ method, params });
  }

  abort(error: Error = cancelledError()) {
    this.fail(error);
    return this.close();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = new Promise<void>((resolve) => {
      if (this.exited || this.child.pid === undefined) {
        resolve();
        return;
      }
      const finish = () => {
        clearTimeout(force);
        clearTimeout(deadline);
        resolve();
      };
      const force = setTimeout(() => this.kill('SIGKILL'), 1_000);
      const deadline = setTimeout(finish, 2_000);
      this.child.once('close', finish);
      this.child.stdin.end();
      this.kill('SIGTERM');
    });
    this.fail(new CodexError('CODEX_CLOSED', 'Codex 连接已关闭。'));
    return this.closing;
  }

  private kill(signal: NodeJS.Signals) {
    const pid = this.child.pid;
    if (pid === undefined || this.exited) return;
    try {
      if (this.detached) process.kill(-pid, signal);
      else this.child.kill(signal);
    } catch {
      // The process may exit between the status check and the signal.
    }
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.failures) listener(error);
    this.failures.clear();
    this.notifications.clear();
    if (!this.closing) void this.close();
  }

  private write(message: unknown) {
    if (this.child.stdin.destroyed) {
      this.fail(new CodexError('CODEX_DISCONNECTED', 'Codex 连接已中断，请重试备课。'));
      return;
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private read(chunk: Buffer) {
    if (this.failure) return;
    this.buffer += this.decoder.write(chunk);
    const maxLineBytes = this.options.maxLineBytes ?? 1_048_576;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > maxLineBytes) {
        this.fail(new CodexError('CODEX_PROTOCOL', 'Codex 返回的数据过大，备课已停止。'));
        return;
      }
      if (!line.trim()) continue;
      try {
        this.receive(messageSchema.parse(JSON.parse(line)));
      } catch {
        this.fail(new CodexError('CODEX_PROTOCOL', 'Codex 返回了不兼容的数据，请检查版本后重试。'));
        return;
      }
      if (this.failure) return;
    }
    if (Buffer.byteLength(this.buffer) > maxLineBytes) {
      this.fail(new CodexError('CODEX_PROTOCOL', 'Codex 返回的数据过大，备课已停止。'));
    }
  }

  private receive(message: z.infer<typeof messageSchema>) {
    if (message.method && message.id !== undefined) {
      this.write({
        id: message.id,
        error: { code: -32601, message: 'Interactive requests are not supported by LingoWeave.' },
      });
      this.fail(
        new CodexError(
          'CODEX_REQUIRES_ACTION',
          'Codex 需要额外授权或账户操作。请在 Codex 中处理后重新准备。',
        ),
      );
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new CodexError('CODEX_REQUEST_FAILED', 'Codex 拒绝了请求，请检查登录、模型与运行配置。'),
        );
      } else if ('result' in message) {
        pending.resolve(message.result);
      } else {
        pending.reject(new CodexError('CODEX_PROTOCOL', 'Codex 返回了不完整的响应。'));
      }
      return;
    }
    if (message.method) {
      for (const listener of this.notifications) listener(message.method, message.params);
      return;
    }
    throw new Error('Unrecognized protocol frame');
  }
}
