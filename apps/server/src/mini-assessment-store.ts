import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  miniAssessmentApplicationSchema,
  miniAssessmentDetailSchema,
  miniAssessmentJobSchema,
  miniAssessmentResultSchema,
  miniAssessmentRetrySchema,
  miniAssessmentSourceSchema,
  type MiniAssessmentApplication,
  type MiniAssessmentDetail,
  type MiniAssessmentReceipt,
  type MiniAssessmentSnapshot,
  type MiniAssessmentSource,
} from '@lingoweave/contracts';
import { LearningError } from './learning-store.js';
import { MiniExpressionGrades } from './mini-expression-grades.js';
import type { PreparationRuntime } from './preparation-service.js';
import { swiftTime } from './mini-study.js';

const row = z.object({ body: z.string() });
export function miniAssessmentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Task storage shares mini-ai.sqlite, but owns neither answers nor learning completion. */
export class MiniAssessmentStore {
  private readonly db: DatabaseSync;
  constructor(
    filename: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS mini_assessment_jobs(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mini_assessment_requests(id TEXT PRIMARY KEY,hash TEXT NOT NULL,job_id TEXT NOT NULL);`);
    this.all();
  }
  expressionGrades(runtime: PreparationRuntime) {
    return new MiniExpressionGrades(this.db, runtime);
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private write(detail: MiniAssessmentDetail) {
    const valid = miniAssessmentDetailSchema.parse(detail);
    this.db
      .prepare(
        'INSERT INTO mini_assessment_jobs(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(valid.job.id, JSON.stringify(valid));
    return valid;
  }
  all(): MiniAssessmentDetail[] {
    return this.db
      .prepare('SELECT body FROM mini_assessment_jobs ORDER BY rowid')
      .all()
      .map((value) => miniAssessmentDetailSchema.parse(JSON.parse(row.parse(value).body)));
  }
  dataMetrics() {
    return this.db
      .prepare(
        "SELECT json_extract(body,'$.job.sourceId') AS sourceId, json_extract(body,'$.job.status') AS status FROM mini_assessment_jobs",
      )
      .all()
      .map((value) =>
        z
          .object({ sourceId: z.string(), status: miniAssessmentJobSchema.shape.status })
          .parse(value),
      );
  }
  detail(id: string): MiniAssessmentDetail {
    const value = this.db
      .prepare('SELECT body FROM mini_assessment_jobs WHERE id=?')
      .get(id.toLowerCase());
    if (!value) throw new LearningError('ASSESSMENT_NOT_FOUND', '找不到这项学习评价。', 404);
    return miniAssessmentDetailSchema.parse(JSON.parse(row.parse(value).body));
  }
  translationReview(id: string) {
    const row = this.db
      .prepare(
        "SELECT json_extract(body, '$.job.status') AS status, json_extract(body, '$.application.result') AS result FROM mini_assessment_jobs WHERE id=?",
      )
      .get(id.toLowerCase());
    if (!row) return null;
    return {
      status: miniAssessmentJobSchema.shape.status.parse(row.status),
      result:
        row.result === null
          ? null
          : miniAssessmentResultSchema.parse(JSON.parse(z.string().parse(row.result))),
    };
  }
  snapshot(): MiniAssessmentSnapshot {
    const all = this.all().map((detail) => detail.job);
    const completed = all.filter((job) => job.status === 'completed').slice(-50);
    const unfinished = all.filter((job) => job.status !== 'completed');
    return {
      schemaVersion: 1,
      pendingCount: all.filter((job) => job.status === 'queued').length,
      runningCount: all.filter((job) => job.status === 'running').length,
      failedCount: all.filter((job) => job.status === 'failed').length,
      jobs: [...completed, ...unfinished].sort((a, b) => b.createdAt - a.createdAt),
    };
  }
  ensure(raw: MiniAssessmentSource): MiniAssessmentDetail {
    const source = miniAssessmentSourceSchema.parse(raw);
    return this.transaction(() => {
      const previous = this.db
        .prepare('SELECT body FROM mini_assessment_jobs WHERE id=?')
        .get(source.id);
      if (previous) {
        const detail = miniAssessmentDetailSchema.parse(JSON.parse(row.parse(previous).body));
        if (miniAssessmentHash(detail.source) !== miniAssessmentHash(source))
          throw new LearningError(
            'ASSESSMENT_SOURCE_CHANGED',
            '评价原始证据已发生冲突，不能覆盖。',
          );
        return detail;
      }
      const time = swiftTime(this.now());
      return this.write({
        source,
        application: null,
        job: {
          id: source.id,
          sourceId: source.id,
          dayId: source.dayId,
          attemptId: source.attemptId,
          word: source.word,
          status: 'queued',
          createdAt: time,
          updatedAt: time,
          retryCount: 0,
          error: null,
          receipt: null,
        },
      });
    });
  }
  status(id: string, status: MiniAssessmentDetail['job']['status'], error: string | null = null) {
    return this.transaction(() => {
      const detail = this.detail(id);
      if (detail.job.status === 'completed') return detail.job;
      detail.job.status = status;
      detail.job.error = error;
      detail.job.updatedAt = swiftTime(this.now());
      return this.write(detail).job;
    });
  }
  saveApplication(
    raw: MiniAssessmentApplication,
    toolRequestId?: string,
  ): MiniAssessmentApplication {
    const application = miniAssessmentApplicationSchema.parse(raw);
    return this.transaction(() => {
      const detail = this.detail(application.requestId);
      const hash = miniAssessmentHash(detail.source);
      if (
        application.source.id !== detail.source.id ||
        miniAssessmentHash(application.source) !== hash ||
        application.result.sourceId !== detail.source.id ||
        application.result.inputHash !== hash ||
        application.trace.inputHash !== hash
      )
        throw new LearningError(
          'ASSESSMENT_TARGET_INVALID',
          '评价必须对应已冻结的原题与原答。',
          403,
        );
      if (toolRequestId) {
        const id = z.uuid().toLowerCase().parse(toolRequestId);
        const requestHash = miniAssessmentHash({
          action: 'submit',
          jobId: detail.job.id,
          result: application.result,
        });
        const prior = this.db
          .prepare('SELECT hash FROM mini_assessment_requests WHERE id=?')
          .get(id);
        if (prior && z.object({ hash: z.string() }).parse(prior).hash !== requestHash)
          throw new LearningError('REQUEST_CONFLICT', '相同请求身份不能用于另一评价结果。');
        if (!prior)
          this.db
            .prepare('INSERT INTO mini_assessment_requests(id,hash,job_id) VALUES(?,?,?)')
            .run(id, requestHash, detail.job.id);
      }
      if (detail.application) {
        if (
          miniAssessmentHash(detail.application.result) !== miniAssessmentHash(application.result)
        )
          throw new LearningError('ASSESSMENT_RESULT_CONFLICT', '已保存评价不能被另一结果覆盖。');
        return detail.application;
      }
      detail.application = application;
      this.write(detail);
      return application;
    });
  }
  complete(id: string, receipt: MiniAssessmentReceipt) {
    return this.transaction(() => {
      const detail = this.detail(id);
      if (!detail.application)
        throw new LearningError('ASSESSMENT_RESULT_MISSING', '没有已保存评价，不能确认完成。');
      if (receipt.requestId !== id || receipt.sourceId !== detail.source.id)
        throw new LearningError('ASSESSMENT_RECEIPT_INVALID', '评价回执不属于当前原答。');
      detail.job.status = 'completed';
      detail.job.error = null;
      detail.job.receipt = receipt;
      detail.job.updatedAt = swiftTime(this.now());
      return this.write(detail).job;
    });
  }
  retry(raw: { requestId: string; jobId: string }) {
    const input = miniAssessmentRetrySchema.parse(raw);
    return this.transaction(() => {
      const hash = miniAssessmentHash({ action: 'retry', ...input });
      const prior = this.db
        .prepare('SELECT hash,job_id FROM mini_assessment_requests WHERE id=?')
        .get(input.requestId);
      if (prior) {
        const parsed = z.object({ hash: z.string(), job_id: z.string() }).parse(prior);
        if (parsed.hash !== hash)
          throw new LearningError('REQUEST_CONFLICT', '相同请求身份不能用于另一评价操作。');
        return this.detail(parsed.job_id).job;
      }
      const detail = this.detail(input.jobId);
      if (detail.job.status === 'failed') {
        detail.job.status = 'queued';
        detail.job.error = null;
        detail.job.retryCount++;
        detail.job.updatedAt = swiftTime(this.now());
        this.write(detail);
      }
      this.db
        .prepare('INSERT INTO mini_assessment_requests(id,hash,job_id) VALUES(?,?,?)')
        .run(input.requestId, hash, input.jobId);
      return detail.job;
    });
  }
  close() {
    this.db.close();
  }
}
