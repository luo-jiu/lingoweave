import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RuntimeStatus } from '@lingoweave/contracts';
import { LearningError, LearningStore } from './learning-store.js';
import { CodexError } from './codex/transport.js';

export interface PreparationRuntime {
  status(): Promise<RuntimeStatus>;
  prepare(options: {
    jobId: string;
    model?: string;
    instructions: string;
    mcp: { command: string; args: string[]; env: Record<string, string> };
    skill?: { name: string; path: string };
    onThread?: (thread: { threadId: string; model: string }) => void;
    onText: (text: string) => void;
    onProgress: (message: string) => void;
    signal: AbortSignal;
  }): Promise<{ threadId: string; model: string }>;
  close(): Promise<void>;
}

export class PreparationService {
  private readonly active = new Map<
    string,
    { token: string; controller: AbortController; promise: Promise<void> }
  >();
  private baseUrl: string | null = null;
  private closing = false;

  constructor(
    readonly store: LearningStore,
    private readonly runtime: PreparationRuntime,
    readonly agentWorkspace: string,
  ) {
    mkdirSync(agentWorkspace, { recursive: true, mode: 0o700 });
  }

  setBaseUrl(url: string) {
    this.baseUrl = url;
  }
  status() {
    return this.runtime.status();
  }

  prepare(requestId: string, model?: string) {
    if (this.closing || !this.baseUrl)
      throw new LearningError('SERVICE_NOT_READY', '学习服务尚未就绪，请稍后重试。', 503);
    const receipt = this.store.prepare(requestId, model);
    if (receipt.dispatch) this.dispatch(receipt.jobId, model);
    return { jobId: receipt.jobId, reused: receipt.reused };
  }

  private dispatch(jobId: string, model?: string) {
    const token = randomBytes(32).toString('hex');
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => this.run(jobId, token, controller, model));
    this.active.set(jobId, { token, controller, promise });
    void promise.then(
      () => this.active.delete(jobId),
      () => this.active.delete(jobId),
    );
  }

  private persistFailure(
    jobId: string,
    message: string,
    status: 'failed' | 'interrupted' = 'failed',
  ) {
    try {
      this.store.fail(jobId, message, status);
    } catch {
      console.error(
        'LingoWeave could not save the task failure state. Check local storage before retrying.',
      );
    }
    try {
      this.store.finishMessage(jobId, true);
    } catch {
      console.error('LingoWeave could not finalize the interrupted message.');
    }
  }

  private async run(jobId: string, token: string, controller: AbortController, model?: string) {
    const { signal } = controller;
    let pendingText = '';
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      const text = pendingText;
      pendingText = '';
      if (text && !signal.aborted) {
        try {
          this.store.appendText(jobId, text);
        } catch {
          controller.abort();
          this.persistFailure(jobId, '保存备课进度失败，本次备课已停止。请检查磁盘空间后重试。');
        }
      }
    };
    const append = (text: string) => {
      if (signal.aborted) return;
      pendingText += text;
      if (!flushTimer) flushTimer = setTimeout(flush, 100);
    };
    try {
      if (signal.aborted || !this.store.markRunning(jobId)) return;
      const runtime = await this.runtime.status();
      if (signal.aborted) return;
      if (!runtime.available || !runtime.authenticated)
        throw new LearningError(
          'CODEX_UNAVAILABLE',
          runtime.error ?? '请先在本机终端完成 codex login，再重新准备。',
        );
      if (model && !runtime.models.some((candidate) => candidate.id === model))
        throw new LearningError('MODEL_UNAVAILABLE', '所选模型当前不可用，请刷新模型列表。');
      const compiled = import.meta.url.endsWith('.js');
      const entry = fileURLToPath(
        new URL(compiled ? './learning-mcp.js' : './learning-mcp.ts', import.meta.url),
      );
      const args = compiled ? [entry] : ['--import', import.meta.resolve('tsx'), entry];
      const result = await this.runtime.prepare({
        jobId,
        ...(model ? { model } : {}),
        instructions:
          '使用 lesson-author Skill 为 LingoWeave 当前词组备课。必须先调用 learning_get_context，然后通过 learning_publish_materials 保存完整五词的简单中英例句。不要运行其他电脑任务。面向学习者用中文简短报告进度，例如“正在准备简单例句”，不要提及 Skill 名称、工具名称或内部协议。保存回执成功后结束；不进行考试、聊天教学或修改学习成绩。',
        skill: {
          name: 'lesson-author',
          path: fileURLToPath(new URL('../../../skills/lesson-author/SKILL.md', import.meta.url)),
        },
        mcp: {
          command: process.execPath,
          args,
          env: {
            LINGOWEAVE_MCP_URL: `${this.baseUrl}/api/internal/learning`,
            LINGOWEAVE_MCP_TOKEN: token,
          },
        },
        onThread: ({ threadId, model: selectedModel }) => {
          if (!signal.aborted) this.store.setThread(jobId, threadId, selectedModel);
        },
        onText: append,
        onProgress: (message) => append(`${message}\n`),
        signal,
      });
      flush();
      if (signal.aborted) return;
      this.store.setThread(jobId, result.threadId, result.model);
      if (this.store.getJob(jobId).status !== 'completed')
        this.store.fail(jobId, '备课已结束，但材料尚未通过保存校验。可以重新准备。');
      this.store.finishMessage(jobId);
    } catch (error) {
      flush();
      if (!signal.aborted) {
        const message =
          error instanceof LearningError || error instanceof CodexError
            ? error.message
            : 'Codex 备课中断或暂时不可用。已保存的材料会保留，请检查连接后重试。';
        this.persistFailure(jobId, message);
      }
    } finally {
      if (flushTimer) clearTimeout(flushTimer);
    }
  }

  cancel(jobId: string, requestId: string) {
    const receipt = this.store.cancel(jobId, requestId);
    if (this.store.getJob(jobId).status === 'cancelled') this.active.get(jobId)?.controller.abort();
    return receipt;
  }

  jobForToken(token: string) {
    for (const [jobId, task] of this.active)
      if (task.token === token && !task.controller.signal.aborted) return jobId;
    throw new LearningError('UNAUTHORIZED', '无效或已过期的学习工具会话。', 401);
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    for (const [jobId, task] of this.active) {
      task.controller.abort();
      this.persistFailure(jobId, '服务已停止，已保存的材料仍然保留。可以重新准备。', 'interrupted');
    }
    try {
      await this.runtime.close();
    } finally {
      await Promise.allSettled([...this.active.values()].map((task) => task.promise));
      this.store.close();
    }
  }
}
