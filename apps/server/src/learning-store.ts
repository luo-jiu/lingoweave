import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  learningGroupSchema,
  learningMaterialSchema,
  lexiconWordSchema,
  preparationJobSchema,
  preparationReceiptSchema,
  workspaceEventSchema,
  workspaceSnapshotSchema,
  publishMaterialsSchema,
  type LexiconWord,
  type PreparationJob,
  type PublishMaterialsInput,
  type WorkspaceEvent,
  type WorkspaceSnapshot,
} from '@lingoweave/contracts';
import { z } from 'zod';

export class LearningError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 409,
  ) {
    super(message);
  }
}

const rowSchema = z.object({ body: z.string() });
const countSchema = z.object({ value: z.number() });
const receiptRowSchema = z.object({ fingerprint: z.string(), body: z.string() });
const ACTIVE = new Set<PreparationJob['status']>(['queued', 'running']);

function acquireLock(filename: string) {
  if (filename === ':memory:') return () => {};
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const path = `${filename}.lock`;
  const identity = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, identity);
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          if (readFileSync(path, 'utf8') === identity) unlinkSync(path);
        } catch {
          /* Already removed. */
        }
      };
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const previous = readFileSync(path, 'utf8');
      const parsed = z.object({ pid: z.number().int().positive() }).safeParse(JSON.parse(previous));
      if (!parsed.success)
        throw new Error('Cannot identify the data-directory lock. Check for another server.', {
          cause: error,
        });
      let alive = true;
      try {
        process.kill(parsed.data.pid, 0);
      } catch (probeError) {
        if (probeError instanceof Error && 'code' in probeError && probeError.code === 'ESRCH')
          alive = false;
      }
      if (alive)
        throw new Error('This data directory is already open in another LingoWeave process.', {
          cause: error,
        });
      if (readFileSync(path, 'utf8') === previous) unlinkSync(path);
    }
  }
  throw new Error('Could not acquire the LingoWeave data-directory lock.');
}

export class LearningStore {
  private readonly db: DatabaseSync;
  private readonly releaseLock: () => void;
  private readonly listeners = new Set<(event: WorkspaceEvent) => void>();
  private pendingEvents: WorkspaceEvent[] = [];
  private closed = false;

  constructor(filename: string, words: LexiconWord[]) {
    if (words.length < 5) throw new Error('The starter lexicon needs at least five words.');
    this.releaseLock = acquireLock(filename);
    try {
      this.db = new DatabaseSync(filename);
    } catch (error) {
      this.releaseLock();
      throw error;
    }
    try {
      if (filename !== ':memory:') chmodSync(filename, 0o600);
      this.db.exec(
        'PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;',
      );
      const version = z
        .object({ user_version: z.number() })
        .parse(this.db.prepare('PRAGMA user_version').get()).user_version;
      if (version > 1) throw new Error('This database was created by a newer LingoWeave version.');
      if (version === 0)
        this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE lexicon (id TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE, body TEXT NOT NULL);
        CREATE TABLE groups (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE jobs (id TEXT PRIMARY KEY, attempt INTEGER NOT NULL UNIQUE, body TEXT NOT NULL);
        CREATE TABLE materials (word_id TEXT PRIMARY KEY REFERENCES lexicon(id), body TEXT NOT NULL);
        CREATE TABLE messages (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), text TEXT NOT NULL, status TEXT NOT NULL);
        CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
        CREATE TABLE receipts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE tool_calls (id INTEGER PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), tool TEXT NOT NULL, created_at TEXT NOT NULL);
        PRAGMA user_version = 1;
        COMMIT;
      `);
      this.atomic(() => {
        words.forEach((word, position) => {
          const validated = lexiconWordSchema.parse(word);
          this.db
            .prepare('INSERT OR IGNORE INTO lexicon (id, position, body) VALUES (?, ?, ?)')
            .run(validated.id, position, JSON.stringify(validated));
        });
        const current = this.latestJob();
        if (current && ACTIVE.has(current.status)) {
          this.writeJob({
            ...current,
            status: 'interrupted',
            error: '服务已重启，已保存的材料仍然保留。可以重新准备。',
            updatedAt: new Date().toISOString(),
          });
          this.event(current.id, 'job');
        }
        this.db
          .prepare("UPDATE messages SET status = 'interrupted' WHERE status = 'streaming'")
          .run();
      });
    } catch (error) {
      this.db.close();
      this.releaseLock();
      throw error;
    }
  }

  private atomic<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    this.pendingEvents = [];
    let result: T;
    try {
      result = operation();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.pendingEvents = [];
      throw error;
    }
    const events = this.pendingEvents;
    this.pendingEvents = [];
    for (const event of events)
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          /* A disconnected subscriber cannot undo a committed write. */
        }
      }
    return result;
  }

  private event(jobId: string, kind: WorkspaceEvent['kind']) {
    const body = { jobId, kind, timestamp: new Date().toISOString() };
    const result = this.db
      .prepare('INSERT INTO events (body) VALUES (?)')
      .run(JSON.stringify(body));
    this.pendingEvents.push({ ...body, seq: Number(result.lastInsertRowid) });
  }

  private writeJob(job: PreparationJob) {
    this.db
      .prepare(
        'INSERT INTO jobs (id, attempt, body) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body',
      )
      .run(job.id, job.attempt, JSON.stringify(preparationJobSchema.parse(job)));
  }

  private latestJob(): PreparationJob | null {
    const row = this.db.prepare('SELECT body FROM jobs ORDER BY attempt DESC LIMIT 1').get();
    return row ? preparationJobSchema.parse(JSON.parse(rowSchema.parse(row).body)) : null;
  }

  getJob(id: string): PreparationJob {
    const row = this.db.prepare('SELECT body FROM jobs WHERE id = ?').get(id);
    if (!row) throw new LearningError('JOB_NOT_FOUND', '找不到这次备课任务。', 404);
    return preparationJobSchema.parse(JSON.parse(rowSchema.parse(row).body));
  }

  private receipt(id: string, fingerprint: string) {
    const row = this.db.prepare('SELECT fingerprint, body FROM receipts WHERE id = ?').get(id);
    if (!row) return null;
    const saved = receiptRowSchema.parse(row);
    if (saved.fingerprint !== fingerprint)
      throw new LearningError('REQUEST_CONFLICT', '相同请求身份不能用于不同操作。');
    return preparationReceiptSchema.parse(JSON.parse(saved.body));
  }

  private saveReceipt(
    id: string,
    fingerprint: string,
    receipt: { jobId: string; reused: boolean },
  ) {
    this.db
      .prepare('INSERT INTO receipts (id, fingerprint, body) VALUES (?, ?, ?)')
      .run(id, fingerprint, JSON.stringify(receipt));
    return receipt;
  }

  snapshot(): WorkspaceSnapshot {
    const words = this.db
      .prepare('SELECT body FROM lexicon ORDER BY position LIMIT 5')
      .all()
      .map((row) => lexiconWordSchema.parse(JSON.parse(rowSchema.parse(row).body)));
    const group = this.db.prepare('SELECT body FROM groups LIMIT 1').get();
    const job = this.latestJob();
    const messages = job
      ? this.db
          .prepare(
            'SELECT id, job_id AS jobId, text, status FROM messages WHERE job_id = ? ORDER BY rowid',
          )
          .all(job.id)
      : [];
    return workspaceSnapshotSchema.parse({
      group: group ? learningGroupSchema.parse(JSON.parse(rowSchema.parse(group).body)) : null,
      words,
      lexiconSize: countSchema.parse(this.db.prepare('SELECT COUNT(*) AS value FROM lexicon').get())
        .value,
      materials: this.db
        .prepare('SELECT body FROM materials ORDER BY rowid')
        .all()
        .map((row) => learningMaterialSchema.parse(JSON.parse(rowSchema.parse(row).body))),
      job,
      messages,
      lastEventSeq: countSchema.parse(
        this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS value FROM events').get(),
      ).value,
    });
  }

  prepare(requestId: string, model?: string) {
    return this.atomic(() => {
      const fingerprint = JSON.stringify({ action: 'prepare', model: model ?? null });
      const existingReceipt = this.receipt(requestId, fingerprint);
      if (existingReceipt) return { ...existingReceipt, dispatch: false };
      const latest = this.latestJob();
      if (latest && (ACTIVE.has(latest.status) || latest.status === 'completed')) {
        return {
          ...this.saveReceipt(requestId, fingerprint, { jobId: latest.id, reused: true }),
          dispatch: false,
        };
      }
      const snapshot = this.snapshot();
      const now = new Date().toISOString();
      const group = snapshot.group ?? {
        id: randomUUID(),
        title: '从五个日常单词开始',
        wordIds: snapshot.words.map((word) => word.id),
        stage: 'preparing' as const,
        createdAt: now,
      };
      this.db
        .prepare('INSERT OR IGNORE INTO groups (id, body) VALUES (?, ?)')
        .run(group.id, JSON.stringify(group));
      const job: PreparationJob = {
        id: randomUUID(),
        groupId: group.id,
        attempt: (latest?.attempt ?? 0) + 1,
        status: 'queued',
        model: model ?? null,
        threadId: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      this.writeJob(job);
      this.event(job.id, 'job');
      return {
        ...this.saveReceipt(requestId, fingerprint, { jobId: job.id, reused: false }),
        dispatch: true,
      };
    });
  }

  markRunning(id: string) {
    return this.atomic(() => {
      const job = this.getJob(id);
      if (job.status !== 'queued') return false;
      this.writeJob({ ...job, status: 'running', updatedAt: new Date().toISOString() });
      this.event(id, 'job');
      return true;
    });
  }

  setThread(id: string, threadId: string, model: string) {
    this.atomic(() => {
      const job = this.getJob(id);
      if (!ACTIVE.has(job.status)) return;
      this.writeJob({ ...job, threadId, model, updatedAt: new Date().toISOString() });
      this.event(id, 'job');
    });
  }

  appendText(id: string, delta: string) {
    if (!delta) return;
    this.atomic(() => {
      const job = this.getJob(id);
      if (!ACTIVE.has(job.status) && job.status !== 'completed') return;
      this.db
        .prepare(
          `INSERT INTO messages (id, job_id, text, status) VALUES (?, ?, ?, 'streaming')
        ON CONFLICT(id) DO UPDATE SET text = substr(messages.text || excluded.text, 1, 12000)`,
        )
        .run(id, id, delta.slice(0, 12000));
      this.event(id, 'message');
    });
  }

  finishMessage(id: string, interrupted = false) {
    this.atomic(() => {
      const result = this.db
        .prepare('UPDATE messages SET status = ? WHERE job_id = ? AND status = ?')
        .run(interrupted ? 'interrupted' : 'complete', id, 'streaming');
      if (result.changes) this.event(id, 'message');
    });
  }

  fail(id: string, error: string, status: 'failed' | 'interrupted' = 'failed') {
    this.atomic(() => {
      const job = this.getJob(id);
      if (!ACTIVE.has(job.status)) return;
      this.writeJob({ ...job, status, error, updatedAt: new Date().toISOString() });
      this.db.prepare("UPDATE messages SET status = 'interrupted' WHERE job_id = ?").run(id);
      this.event(id, 'job');
    });
  }

  cancel(id: string, requestId: string) {
    return this.atomic(() => {
      const fingerprint = JSON.stringify({ action: 'cancel', jobId: id });
      const receipt = this.receipt(requestId, fingerprint);
      if (receipt) return receipt;
      const job = this.getJob(id);
      const active = ACTIVE.has(job.status);
      if (active) {
        this.writeJob({
          ...job,
          status: 'cancelled',
          error: null,
          updatedAt: new Date().toISOString(),
        });
        this.db.prepare("UPDATE messages SET status = 'interrupted' WHERE job_id = ?").run(id);
        this.event(id, 'job');
      }
      return this.saveReceipt(requestId, fingerprint, { jobId: id, reused: !active });
    });
  }

  toolContext(id: string) {
    return this.atomic(() => {
      if (this.getJob(id).status !== 'running')
        throw new LearningError('STALE_JOB', '当前备课已结束，请勿继续写入。');
      this.db
        .prepare('INSERT INTO tool_calls (job_id, tool, created_at) VALUES (?, ?, ?)')
        .run(id, 'learning_get_context', new Date().toISOString());
      const snapshot = this.snapshot();
      return {
        group: snapshot.group,
        words: snapshot.words,
        job: snapshot.job,
        materials: snapshot.materials,
        history: [],
        historyNote: 'D0 尚无学习作答记录；材料准备不计入掌握或复习成绩。',
      };
    });
  }

  publish(id: string, rawInput: PublishMaterialsInput) {
    const input = publishMaterialsSchema.parse(rawInput);
    return this.atomic(() => {
      const fingerprint = JSON.stringify({
        action: 'publish',
        jobId: id,
        materials: input.materials,
      });
      const requestId = `publish:${id}:${input.requestId}`;
      const old = this.receipt(requestId, fingerprint);
      if (old) return old;
      const job = this.getJob(id);
      if (job.status !== 'running' || this.latestJob()?.id !== id)
        throw new LearningError('STALE_JOB', '这次备课已结束或已被替换。');
      const read = this.db
        .prepare('SELECT id FROM tool_calls WHERE job_id = ? AND tool = ? LIMIT 1')
        .get(id, 'learning_get_context');
      if (!read) throw new LearningError('CONTEXT_REQUIRED', '请先查询当前词组，再提交材料。');
      const snapshot = this.snapshot();
      const ids = new Set(input.materials.map((material) => material.wordId));
      if (ids.size !== snapshot.words.length || snapshot.words.some((word) => !ids.has(word.id)))
        throw new LearningError('INVALID_TARGETS', '材料必须准确覆盖当前词组，每词一条。', 422);
      for (const material of input.materials) {
        const word = snapshot.words.find((candidate) => candidate.id === material.wordId);
        const tokens: string[] = material.english.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? [];
        if (!word || !tokens.includes(word.lemma.toLowerCase()) || tokens.length > 18)
          throw new LearningError(
            'INVALID_SENTENCE',
            '每条例句需包含目标词原形，且不超过 18 个英文单词。',
            422,
          );
      }
      const now = new Date().toISOString();
      for (const material of input.materials) {
        const body = { ...material, source: 'ai-generated' as const, jobId: id, createdAt: now };
        this.db
          .prepare('INSERT INTO materials (word_id, body) VALUES (?, ?)')
          .run(material.wordId, JSON.stringify(body));
      }
      if (!snapshot.group) throw new Error('Missing preparation group');
      this.db
        .prepare('UPDATE groups SET body = ? WHERE id = ?')
        .run(JSON.stringify({ ...snapshot.group, stage: 'ready' }), job.groupId);
      this.writeJob({ ...job, status: 'completed', error: null, updatedAt: now });
      this.db
        .prepare('INSERT INTO tool_calls (job_id, tool, created_at) VALUES (?, ?, ?)')
        .run(id, 'learning_publish_materials', now);
      this.event(id, 'materials');
      return this.saveReceipt(requestId, fingerprint, { jobId: id, reused: false });
    });
  }

  eventsAfter(seq: number): WorkspaceEvent[] {
    return this.db
      .prepare('SELECT seq, body FROM events WHERE seq > ? ORDER BY seq LIMIT 1000')
      .all(seq)
      .map((row) =>
        workspaceEventSchema.parse({ ...JSON.parse(rowSchema.parse(row).body), seq: row.seq }),
      );
  }

  subscribe(listener: (event: WorkspaceEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    try {
      this.db.close();
    } finally {
      this.releaseLock();
    }
  }
}
