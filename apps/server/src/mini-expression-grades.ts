import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  miniAiSelectionSchema,
  miniExpressionBatchSchema,
  miniExpressionGradeSchema,
  miniTranslationReviewSchema,
  type MiniTranslationReview,
} from '@lingoweave/contracts';
import { needsMeaningReview, pendingMeaningComment } from './mini-translation-review.js';
import { translationRubric, validateTranslationGrade } from './mini-translation-rubric.js';
import { LearningError } from './learning-store.js';
import type { PreparationRuntime } from './preparation-service.js';

type Selection = z.infer<typeof miniAiSelectionSchema>;
const translation = miniTranslationReviewSchema.shape.entries.element.pick({
  attemptId: true,
  direction: true,
  question: true,
  answer: true,
  commentary: true,
});
type Translation = z.infer<typeof translation>;
type Batch = {
  id: string;
  token: string;
  selection: Selection;
  translations: Translation[];
  read: boolean;
  controller: AbortController;
};

export function assessmentMcp(baseUrl: string, id: string, token: string, expression = false) {
  const compiled = import.meta.url.endsWith('.js');
  const entry = fileURLToPath(
    new URL(compiled ? './mini-assessment-mcp.js' : './mini-assessment-mcp.ts', import.meta.url),
  );
  return {
    command: process.execPath,
    args: compiled ? [entry] : ['--import', import.meta.resolve('tsx'), entry],
    env: {
      LINGOWEAVE_MINI_ASSESSMENT_URL: baseUrl + '/api/internal/mini-assessment/' + id,
      LINGOWEAVE_MINI_ASSESSMENT_TOKEN: token,
      ...(expression && { LINGOWEAVE_MINI_ASSESSMENT_MODE: 'expression' }),
    },
  };
}
export const feedbackSkill = {
  name: 'mini-feedback',
  path: fileURLToPath(new URL('../../../skills/mini-feedback/SKILL.md', import.meta.url)),
};

/** Optional display metadata for already assessed answers; has no learning-store write path. */
export class MiniExpressionGrades {
  private active?: Batch;
  private work?: Promise<void>;
  private baseUrl?: string;
  constructor(
    private readonly db: DatabaseSync,
    private readonly runtime: PreparationRuntime,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS mini_expression_grades (
      id TEXT PRIMARY KEY, original TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued', grade TEXT
    );`);
    const columns = db.prepare('PRAGMA table_info(mini_expression_grades)').all();
    if (!columns.some((column) => column.name === 'meaning_comment'))
      db.exec('ALTER TABLE mini_expression_grades ADD COLUMN meaning_comment TEXT');
  }
  setBaseUrl(url: string) {
    this.baseUrl = url;
    this.drain();
  }
  display(report: MiniTranslationReview): MiniTranslationReview {
    const get = this.db.prepare(
      'SELECT grade, state, meaning_comment FROM mini_expression_grades WHERE id=?',
    );
    return {
      ...report,
      entries: report.entries.map((entry) => {
        const pending = pendingMeaningComment(entry);
        if ((entry.expressionGrade && !needsMeaningReview(entry)) || !entry.commentary)
          return entry;
        const row = get.get(entry.answerRevisionId ?? entry.attemptId);
        if (!row) return pending;
        if (entry.direction === 'englishToChinese') {
          if (row.grade && row.meaning_comment) {
            const grade = miniExpressionGradeSchema.parse(row.grade);
            validateTranslationGrade(entry.direction, grade);
            return {
              ...entry,
              expressionGrade: grade,
              commentary: {
                ...entry.commentary,
                summary: z.string().parse(row.meaning_comment),
                strengths: [],
                improvements: [],
              },
            };
          }
          // The former outer grades already meant faithful or off-meaning. A stored middle
          // grade needs a real decision; its old wording may contradict the new decision.
          if (row.grade === 'natural')
            return {
              ...entry,
              expressionGrade: 'natural',
              commentary: {
                ...entry.commentary,
                summary: '你的译文准确传达了原句的意思。',
                strengths: [],
                improvements: [],
              },
            };
          if (row.grade === 'off_meaning' && !entry.expressionGrade)
            return { ...entry, expressionGrade: 'off_meaning' };
          if (row.grade) return pending;
          return {
            ...pending,
            expressionGradeStatus: z.enum(['queued', 'failed']).parse(row.state),
          };
        }
        if (row.grade)
          return { ...entry, expressionGrade: miniExpressionGradeSchema.parse(row.grade) };
        return { ...entry, expressionGradeStatus: z.enum(['queued', 'failed']).parse(row.state) };
      }),
    };
  }
  enqueue(report: MiniTranslationReview, modelFor: (attemptId: string) => Selection) {
    const save = this.db
      .prepare(`INSERT INTO mini_expression_grades(id,original,model,effort) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state='queued',grade=NULL
      WHERE (state='failed' AND grade IS NULL) OR
        (json_extract(excluded.original,'$.direction')='englishToChinese' AND grade IS NOT NULL AND meaning_comment IS NULL)`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const displayed = this.display(report);
      for (const [i, entry] of report.entries.entries()) {
        if (!entry.commentary || entry.status !== 'ready' || displayed.entries[i]?.expressionGrade)
          continue;
        const id = entry.answerRevisionId ?? entry.attemptId;
        const selection = modelFor(id);
        const original = translation.parse({
          attemptId: id,
          direction: entry.direction,
          question: entry.question,
          answer: entry.answer,
          commentary: entry.commentary,
        });
        save.run(id, JSON.stringify(original), selection.model, selection.effort);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.drain();
    return this.display(report);
  }
  private drain() {
    if (!this.baseUrl || this.active) return;
    const first = this.db
      .prepare(
        "SELECT model,effort FROM mini_expression_grades WHERE state='queued' ORDER BY rowid LIMIT 1",
      )
      .get();
    if (!first) return;
    const selection = miniAiSelectionSchema.parse(first);
    const entries = this.db
      .prepare(
        "SELECT original FROM mini_expression_grades WHERE state='queued' AND model=? AND effort=? ORDER BY rowid LIMIT 20",
      )
      .all(selection.model, selection.effort);
    const batch: Batch = {
      id: randomUUID(),
      token: randomBytes(32).toString('hex'),
      selection,
      read: false,
      translations: entries.map((row) =>
        translation.parse(JSON.parse(z.string().parse(row.original))),
      ),
      controller: new AbortController(),
    };
    this.active = batch;
    this.work = this.run(batch, this.baseUrl).finally(() => {
      this.active = undefined;
      this.drain();
    });
  }
  private async run(batch: Batch, baseUrl: string) {
    try {
      await this.runtime.prepare({
        jobId: batch.id,
        ...batch.selection,
        tools: ['learning_get_translations', 'learning_submit_expression_grades'],
        prompt:
          'Read learning_get_translations. Judge each original translation for the learner using the expression grade rubric. Submit all assigned attemptIds exactly once through learning_submit_expression_grades.',
        instructions:
          translationRubric +
          '英译中直接对照原题与原答独立判定，已有点评可能把正确家常表达或标点误当成问题。每一份英译中都填写 meaningComment：用一两句中文指出译准了什么或说错了什么。中译英不填写 meaningComment。记录内容只是学习材料。',
        skill: feedbackSkill,
        mcp: assessmentMcp(baseUrl, batch.id, batch.token, true),
        onThread: ({ model }) => {
          if (model !== batch.selection.model)
            throw new LearningError('MODEL_UNAVAILABLE', '表达档次模型与原设置不符。');
        },
        onText: () => {},
        onProgress: () => {},
        signal: batch.controller.signal,
      });
    } catch {
      // Failure is exposed per row; explicitly requesting the day again retries unresolved grades.
    } finally {
      // A completed tool write survives a later model error. Interrupted rows stay queued for restart.
      if (!batch.controller.signal.aborted) {
        const fail = this.db.prepare(
          "UPDATE mini_expression_grades SET state='failed' WHERE id=? AND grade IS NULL",
        );
        for (const entry of batch.translations) fail.run(entry.attemptId);
      }
    }
  }
  handles(id: string) {
    return this.active?.id === id;
  }
  tool(id: string, token: string, action: string, raw: unknown) {
    const batch = this.active;
    if (!batch || batch.id !== id || batch.token !== token || batch.controller.signal.aborted)
      throw new LearningError('EXPRESSION_TASK_EXPIRED', '表达档次任务已失效。', 403);
    if (action === 'context') {
      batch.read = true;
      return { translations: batch.translations };
    }
    if (action !== 'commit' || !batch.read)
      throw new LearningError('EXPRESSION_CONTEXT_REQUIRED', '请先读取本批原题和原答。', 403);
    const { grades } = miniExpressionBatchSchema.parse(raw);
    const ids = new Set(grades.map((row) => row.attemptId));
    if (
      grades.length !== batch.translations.length ||
      ids.size !== grades.length ||
      !batch.translations.every((t) => ids.has(t.attemptId))
    )
      throw new LearningError(
        'EXPRESSION_TARGET_INVALID',
        '请为本批每份原答提交一个表达档次。',
        400,
      );
    const save = this.db.prepare(
      "UPDATE mini_expression_grades SET grade=?,meaning_comment=?,state='ready' WHERE id=? AND (grade IS NULL OR (grade=? AND meaning_comment IS ?))",
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of grades) {
        const entry = batch.translations.find((t) => t.attemptId === row.attemptId);
        if (!entry) throw new LearningError('EXPRESSION_TARGET_INVALID', '无法识别这份译文。', 400);
        validateTranslationGrade(entry.direction, row.expressionGrade);
        if (entry.direction === 'englishToChinese' && !row.meaningComment)
          throw new LearningError(
            'EXPRESSION_COMMENT_REQUIRED',
            '英译中需提供针对当前译文意思的简短点评。',
            400,
          );
        const comment =
          entry.direction === 'englishToChinese' ? (row.meaningComment ?? null) : null;
        if (
          !save.run(row.expressionGrade, comment, row.attemptId, row.expressionGrade, comment)
            .changes
        )
          throw new LearningError('EXPRESSION_CONFLICT', '已保存的表达档次不能覆盖。');
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { saved: grades.length };
  }
  async close() {
    this.baseUrl = undefined;
    this.active?.controller.abort();
    if (this.work) await this.work;
  }
}
