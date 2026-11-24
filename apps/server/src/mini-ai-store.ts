import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { withoutMiniPlanMinutes } from './mini-plan-migration.js';
import {
  miniAiSnapshotSchema,
  miniAiStartSchema,
  miniAiImportSchema,
  miniAiControlSchema,
  miniAiClearSchema,
  miniCommandSchema,
  type MiniAiSnapshot,
  type MiniAiStart,
  type MiniAiImport,
  type MiniAiJob,
  type MiniCommand,
  type MiniAssessmentSource,
  type MiniWord,
} from '@lingoweave/contracts';
import { LearningError } from './learning-store.js';
import { sameWord, swiftTime } from './mini-study.js';

const rowSchema = z.object({ body: z.string() });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const running = (job: MiniAiJob) => job.status === 'queued' || job.status === 'running';
export class MiniAiStore {
  private readonly db: DatabaseSync;
  constructor(
    filename: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    const version = z
      .object({ user_version: z.number().int() })
      .parse(this.db.prepare('PRAGMA user_version').get()).user_version;
    if (version > 1) {
      this.db.close();
      throw new LearningError('AI_DATABASE_VERSION', '聊天数据来自更新版本，请升级应用后打开。');
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS ai_state(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_requests(id TEXT PRIMARY KEY,hash TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_inputs(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_deleted_jobs(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS ai_tools(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,tool TEXT NOT NULL,body TEXT NOT NULL);
      PRAGMA user_version=1;`);
    this.db.prepare('INSERT OR IGNORE INTO ai_state(id,body) VALUES(1,?)').run(
      JSON.stringify({
        schemaVersion: 1,
        revision: 0,
        imported: false,
        conversations: [],
        messages: [],
        jobs: [],
      }),
    );
    this.raw();
  }
  private raw(): MiniAiSnapshot {
    return miniAiSnapshotSchema.parse(
      JSON.parse(
        rowSchema.parse(this.db.prepare('SELECT body FROM ai_state WHERE id=1').get()).body,
      ),
    );
  }
  jobs(): MiniAiJob[] {
    return this.raw().jobs;
  }
  snapshot(): MiniAiSnapshot {
    const state = this.raw();
    return { ...state, messages: state.messages.slice(-200), jobs: state.jobs.slice(-50) };
  }
  dataMetrics() {
    const state = this.raw();
    return { conversations: state.conversations.length, messages: state.messages.length };
  }
  private mutate<T>(operation: (state: MiniAiSnapshot) => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.raw();
      const value = operation(state);
      state.revision++;
      this.db
        .prepare('UPDATE ai_state SET body=? WHERE id=1')
        .run(JSON.stringify(miniAiSnapshotSchema.parse(state)));
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private previous(id: string, value: unknown): string | null {
    const row = this.db
      .prepare('SELECT hash,result FROM ai_requests WHERE id=?')
      .get(id.toLowerCase());
    if (!row) return null;
    const receipt = z.object({ hash: z.string(), result: z.string() }).parse(row);
    if (receipt.hash !== digest(value))
      throw new LearningError('REQUEST_CONFLICT', '相同请求身份不能用于不同 AI 操作。');
    return receipt.result;
  }
  private receipt(id: string, value: unknown, result: string) {
    this.db
      .prepare('INSERT INTO ai_requests(id,hash,result) VALUES(?,?,?)')
      .run(id.toLowerCase(), digest(value), result);
  }
  job(id: string): MiniAiJob {
    const job = this.raw().jobs.find((item) => item.id === id.toLowerCase());
    if (!job) throw new LearningError('AI_JOB_NOT_FOUND', '找不到这项 AI 任务。', 404);
    return job;
  }
  input(id: string): MiniAiStart {
    if (this.db.prepare('SELECT id FROM ai_deleted_jobs WHERE id=?').get(id))
      throw new LearningError('AI_CONVERSATION_CLEARED', '这段聊天已清除，旧任务不能重试。');
    return miniAiStartSchema.parse(
      JSON.parse(
        rowSchema.parse(this.db.prepare('SELECT body FROM ai_inputs WHERE id=?').get(id)).body,
      ),
    );
  }
  userMessage(id: string) {
    return this.raw().messages.find((message) => message.jobId === id && message.role === 'user');
  }
  messages(conversationId: string) {
    const messages = this.raw().messages.filter(
      (message) => message.conversationId === conversationId,
    );
    const opening = messages[0];
    // Anchor a long scene without resending its entire transcript on every turn.
    if (conversationId.startsWith('dialogue:') && messages.length > 12 && opening)
      return [opening, ...messages.slice(-11)];
    return messages.slice(-12);
  }
  discussionForAssessment(
    word: MiniWord,
    submittedAt: number,
    confirmedAt: number,
  ): MiniAssessmentSource['discussion'] {
    const state = this.raw();
    const conversations = new Set(
      state.conversations
        .filter((item) => item.word && sameWord(item.word, word))
        .map((item) => item.id),
    );
    return state.messages
      .filter(
        (message) =>
          conversations.has(message.conversationId) &&
          message.createdAt !== null &&
          message.createdAt <= confirmedAt,
      )
      .slice(-24)
      .flatMap((message) =>
        message.createdAt === null
          ? []
          : [
              {
                id: message.id,
                role: message.role,
                text: message.text,
                occurredAt: message.createdAt,
                relation:
                  message.createdAt <= submittedAt
                    ? ('before_answer' as const)
                    : ('after_answer' as const),
              },
            ],
      );
  }
  start(raw: MiniAiStart, validate?: () => void): { job: MiniAiJob; dispatch: boolean } {
    const input = miniAiStartSchema.parse(raw);
    return this.mutate((state) => {
      const previous = this.previous(input.requestId, input);
      if (previous) return { job: this.job(previous), dispatch: false };
      validate?.();
      if (!state.imported) throw new LearningError('AI_IMPORT_REQUIRED', '请先迁入原有聊天记录。');
      const shared = state.jobs.find(
        (job) =>
          running(job) &&
          (input.kind === 'advisor' || input.kind === 'dialogue'
            ? job.conversationId === input.conversationId
            : job.kind === input.kind &&
              job.dayId === input.dayId &&
              job.attemptId === input.attemptId),
      );
      if (shared) {
        if (input.kind === 'advisor' || input.kind === 'dialogue')
          throw new LearningError('AI_BUSY', '这段对话仍在处理，请等待或停止后再发送。');
        this.receipt(input.requestId, input, shared.id);
        return { job: shared, dispatch: false };
      }
      if (input.kind === 'dialogue') {
        const scene = state.jobs.filter((job) => job.conversationId === input.conversationId);
        const latest = scene.at(-1);
        if (!input.message && !input.dialogueStep) {
          if (state.conversations.some((conv) => conv.id === input.conversationId))
            throw new LearningError('DIALOGUE_EXISTS', '该场景已创建，请继续原对话或新建场景。');
        } else if (
          !latest ||
          latest.kind !== 'dialogue' ||
          latest.status !== 'completed' ||
          latest.dialogueStep === 'reflect'
        ) {
          throw new LearningError('DIALOGUE_NOT_OPEN', '请先开始场景或重试上次对话。');
        } else if (
          input.dialogueStep === 'reflect' &&
          !state.messages.some(
            (message) => message.conversationId === input.conversationId && message.role === 'user',
          )
        ) {
          throw new LearningError('DIALOGUE_NO_REPLY', '写过回复后才有可回顾的内容。');
        }
      }
      const id = randomUUID(),
        time = swiftTime(this.now());
      const job: MiniAiJob = {
        id,
        requestId: input.requestId,
        kind: input.kind,
        status: 'queued',
        ...(input.dayId ? { dayId: input.dayId } : {}),
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        conversationId: input.conversationId,
        ...(input.dialogueStep ? { dialogueStep: input.dialogueStep } : {}),
        model: input.model,
        effort: input.effort,
        progress: '等待处理…',
        text: '',
        receipts: [],
        error: null,
        createdAt: time,
        updatedAt: time,
        threadId: null,
      };
      state.jobs.push(job);
      if (!state.conversations.some((conv) => conv.id === input.conversationId))
        state.conversations.push({
          id: input.conversationId,
          title: input.kind === 'dialogue' ? '英文对话' : (input.word?.spelling ?? '学习顾问'),
          word: input.word ?? null,
        });
      if ((input.kind === 'advisor' || input.kind === 'dialogue') && input.message)
        state.messages.push({
          id: input.requestId,
          conversationId: input.conversationId,
          role: 'user',
          text: input.message,
          createdAt: time,
          jobId: id,
        });
      this.db.prepare('INSERT INTO ai_inputs(id,body) VALUES(?,?)').run(id, JSON.stringify(input));
      this.receipt(input.requestId, input, id);
      return { job, dispatch: true };
    });
  }
  update(id: string, update: (job: MiniAiJob) => void) {
    return this.mutate((state) => {
      const job = state.jobs.find((item) => item.id === id);
      if (!job) throw new LearningError('AI_JOB_NOT_FOUND', '找不到这项 AI 任务。', 404);
      update(job);
      job.updatedAt = swiftTime(this.now());
      return job;
    });
  }
  finish(id: string, status: MiniAiJob['status'], error: string | null = null) {
    return this.mutate((state) => {
      const job = state.jobs.find((item) => item.id === id);
      if (!job) throw new LearningError('AI_JOB_NOT_FOUND', '找不到这项 AI 任务。', 404);
      job.status = status;
      job.error = error;
      job.updatedAt = swiftTime(this.now());
      job.progress = status === 'completed' ? '已完成' : (error ?? '已停止');
      if (
        (job.kind === 'advisor' || (job.kind === 'dialogue' && status === 'completed')) &&
        job.text.trim()
      ) {
        const existing = state.messages.find(
          (message) => message.jobId === id && message.role === 'assistant',
        );
        if (existing) {
          existing.text = job.text;
          existing.createdAt = job.updatedAt;
        } else
          state.messages.push({
            id: randomUUID(),
            conversationId: job.conversationId,
            role: 'assistant',
            text: job.text,
            createdAt: job.updatedAt,
            jobId: id,
          });
      }
      return job;
    });
  }
  control(
    raw: { requestId: string; jobId: string },
    kind: 'cancel' | 'retry',
    validateRetry?: () => void,
  ) {
    const input = miniAiControlSchema.parse(raw);
    return this.mutate((state) => {
      const value = { kind, ...input };
      const previous = this.previous(input.requestId, value);
      if (previous) return { job: this.job(previous), dispatch: false };
      if (
        kind === 'retry' &&
        this.db.prepare('SELECT id FROM ai_deleted_jobs WHERE id=?').get(input.jobId)
      )
        throw new LearningError('AI_CONVERSATION_CLEARED', '这段聊天已清除，旧任务不能重试。');
      const job = state.jobs.find((item) => item.id === input.jobId);
      if (!job) throw new LearningError('AI_JOB_NOT_FOUND', '找不到这项 AI 任务。', 404);
      let dispatch = false;
      if (kind === 'cancel' && running(job)) {
        job.status = 'cancelled';
        job.progress = '已停止，已保存内容保留。';
      }
      if (kind === 'retry' && !running(job) && job.status !== 'completed') {
        validateRetry?.();
        job.status = 'queued';
        job.error = null;
        job.text = '';
        job.progress = '等待重试…';
        state.messages = state.messages.filter(
          (message) => !(message.jobId === job.id && message.role === 'assistant'),
        );
        dispatch = true;
      }
      job.updatedAt = swiftTime(this.now());
      this.receipt(input.requestId, value, job.id);
      return { job, dispatch };
    });
  }
  importLegacy(raw: MiniAiImport) {
    const input = miniAiImportSchema.parse(raw);
    this.mutate((state) => {
      if (this.previous(input.requestId, input)) return;
      if (state.imported)
        throw new LearningError('AI_ALREADY_IMPORTED', '聊天已经迁入，不能覆盖现有记录。');
      const ids = new Set<string>();
      for (const conv of input.conversations) {
        if (
          conv.id.startsWith('dialogue:') ||
          state.conversations.some((item) => item.id === conv.id)
        )
          throw new LearningError('AI_IMPORT_INVALID', '聊天分组身份重复。', 400);
        state.conversations.push({ id: conv.id, title: conv.title, word: conv.word });
        for (const message of conv.messages) {
          if (ids.has(message.id))
            throw new LearningError('AI_IMPORT_INVALID', '聊天消息身份重复。', 400);
          ids.add(message.id);
          state.messages.push({
            ...message,
            conversationId: conv.id,
            createdAt: null,
            jobId: null,
          });
        }
      }
      state.imported = true;
      this.receipt(input.requestId, input, 'import');
    });
    return this.snapshot();
  }
  clear(raw: { requestId: string; conversationId: string }) {
    const input = miniAiClearSchema.parse(raw);
    this.mutate((state) => {
      if (this.previous(input.requestId, input)) return;
      state.messages = state.messages.filter(
        (message) => message.conversationId !== input.conversationId,
      );
      for (const job of state.jobs.filter((job) => job.conversationId === input.conversationId)) {
        job.status = 'cancelled';
        job.text = '';
        job.error = null;
        job.progress = '这段聊天已清除。';
        this.db.prepare('INSERT OR IGNORE INTO ai_deleted_jobs(id) VALUES(?)').run(job.id);
        this.db.prepare('DELETE FROM ai_inputs WHERE id=?').run(job.id);
        this.db.prepare('DELETE FROM ai_tools WHERE job_id=?').run(job.id);
      }
      this.receipt(input.requestId, input, 'clear');
    });
    return this.snapshot();
  }
  toolCommand(jobId: string, tool: string, command: MiniCommand): MiniCommand {
    const existing = this.db
      .prepare('SELECT body FROM ai_tools WHERE id=?')
      .get(command.requestId.toLowerCase());
    if (existing) {
      const prior = z
        .object({ jobId: z.string(), tool: z.string(), command: miniCommandSchema })
        .parse(withoutMiniPlanMinutes(JSON.parse(rowSchema.parse(existing).body)));
      if (
        prior.jobId !== jobId ||
        prior.tool !== tool ||
        digest(prior.command.action) !== digest(command.action)
      )
        throw new LearningError('REQUEST_CONFLICT', '工具请求身份已用于其他内容。');
      return prior.command;
    }
    this.db
      .prepare('INSERT INTO ai_tools(id,job_id,tool,body) VALUES(?,?,?,?)')
      .run(command.requestId.toLowerCase(), jobId, tool, JSON.stringify({ jobId, tool, command }));
    return command;
  }
  completeTool(requestId: string) {
    this.db.prepare('DELETE FROM ai_tools WHERE id=?').run(requestId.toLowerCase());
  }
  pendingTools() {
    return this.db
      .prepare('SELECT body FROM ai_tools')
      .all()
      .map((row) =>
        z
          .object({ jobId: z.string(), tool: z.string(), command: miniCommandSchema })
          .parse(withoutMiniPlanMinutes(JSON.parse(rowSchema.parse(row).body))),
      );
  }
  close() {
    this.db.close();
  }
}
