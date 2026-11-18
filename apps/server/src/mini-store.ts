import { createHash, randomUUID } from 'node:crypto';
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
  miniCommandSchema,
  miniImportSchema,
  miniSnapshotSchema,
  defaultMiniPlanning,
  defaultMiniTeaching,
  defaultMiniScheduling,
  defaultMiniPractice,
  miniPlanPreviewInputSchema,
  type MiniCommand,
  type MiniImport,
  type MiniSnapshot,
  type MiniPlanPreviewInput,
  type MiniPlanPreview,
  type MiniAIContextInput,
  type MiniHistoryInput,
  type MiniHistoryItem,
  type MiniWordContextInput,
  miniAssessmentSourceSchema,
  miniAssessmentApplicationSchema,
  miniAssessmentReceiptSchema,
  type MiniAssessmentSource,
  type MiniAssessmentApplication,
  type MiniAssessmentReceipt,
  type MiniWord,
  type MiniDay,
  miniWordSchema,
} from '@lingoweave/contracts';
import { z } from 'zod';
import { legacyTimedPauseIds, withoutMiniPlanMinutes } from './mini-plan-migration.js';
import { LearningError } from './learning-store.js';
import { swiftTime, validateMiniFacts, sameWord } from './mini-study.js';
import {
  applyFlowAssessment,
  observeMiniFlowScheduling,
  validateMiniFlowScheduling,
} from './mini-flow-scheduler.js';
import {
  applyMiniPlannedAction,
  enforceMiniDueGate,
  miniPlanContext,
  resumeMiniTimePause,
  validateMiniPlanning,
} from './mini-planning.js';
import {
  applyMiniTeachingAction,
  miniAIContext,
  miniHistoryPage,
  miniWordContext,
  validateMiniTeaching,
} from './mini-teaching.js';
import {
  applyMiniMeasurementAction,
  initializeMiniScheduling,
  observeMiniLearningCommand,
  validateMiniScheduling,
} from './mini-scheduler.js';

function lockDatabase(filename: string) {
  if (filename === ':memory:') return () => {};
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const path = `${filename}.lock`;
  const identity = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(descriptor, identity);
      } finally {
        closeSync(descriptor);
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
      const old = readFileSync(path, 'utf8');
      const record = z.object({ pid: z.number().int().positive() }).parse(JSON.parse(old));
      let alive = true;
      try {
        process.kill(record.pid, 0);
      } catch (probe) {
        if (probe instanceof Error && 'code' in probe && probe.code === 'ESRCH') alive = false;
      }
      if (alive)
        throw new Error('This mini data directory is already open in another process.', {
          cause: error,
        });
      if (readFileSync(path, 'utf8') === old) unlinkSync(path);
    }
  }
  throw new Error('Could not acquire the mini data-directory lock.');
}
const stateRow = z.object({ body: z.string() });
const receiptRow = z.object({ fingerprint: z.string() });
const assessmentDraftSchema = miniAssessmentSourceSchema.omit({
  confirmedAt: true,
  discussion: true,
});
function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function emptySnapshot(): MiniSnapshot {
  return {
    schemaVersion: 1,
    revision: 0,
    imported: false,
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
    planning: defaultMiniPlanning(),
    teaching: defaultMiniTeaching(),
    scheduling: defaultMiniScheduling(),
    practice: defaultMiniPractice(),
    assessmentSources: [],
  };
}

export class MiniStore {
  private readonly db: DatabaseSync;
  private readonly releaseLock: () => void;
  private readonly now: () => Date;
  private readonly timezone: string;
  private closed = false;
  private discussionProvider?: (
    word: MiniWord,
    submittedAt: number,
    confirmedAt: number,
  ) => MiniAssessmentSource['discussion'];

  constructor(filename: string, options: { now?: () => Date; timezone?: string } = {}) {
    this.now = options.now ?? (() => new Date());
    this.timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.releaseLock = lockDatabase(filename);
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
      if (version > 8)
        throw new Error('This mini database was created by a newer LingoWeave version.');
      if (version === 0)
        this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE mini_state (id INTEGER PRIMARY KEY CHECK(id = 1), body TEXT NOT NULL);
        CREATE TABLE mini_receipts (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL);
        CREATE TABLE mini_import (id INTEGER PRIMARY KEY CHECK(id = 1), fingerprint TEXT NOT NULL, body TEXT NOT NULL, imported_at REAL NOT NULL);
        CREATE TABLE mini_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, revision INTEGER NOT NULL, request_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, recorded_at REAL NOT NULL);
        PRAGMA user_version = 1;
        COMMIT;
      `);
      this.db
        .prepare('INSERT OR IGNORE INTO mini_state (id,body) VALUES (1,?)')
        .run(JSON.stringify(emptySnapshot()));
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS mini_assessment_records (source_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, application TEXT NOT NULL, receipt TEXT NOT NULL)',
      );
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS mini_assessment_drafts (attempt_id TEXT PRIMARY KEY, body TEXT NOT NULL)',
      );
      const initial = this.snapshot();
      if (version < 8) {
        const stored: unknown = JSON.parse(
          stateRow.parse(this.db.prepare('SELECT body FROM mini_state WHERE id = 1').get()).body,
        );
        if (
          resumeMiniTimePause(
            initial,
            legacyTimedPauseIds(stored),
            this.timezone,
            swiftTime(this.now()),
          )
        )
          initial.revision += 1;
      }
      initializeMiniScheduling(initial);
      if (initial.planning.activeDayId === null && initial.ledger.days.length > 0)
        initial.planning.activeDayId =
          initial.ledger.days.find((day) => day.phase !== 'finished' && !day.paused)?.id ??
          [...initial.ledger.days].reverse().find((day) => day.phase !== 'finished')?.id ??
          initial.ledger.days.at(-1)?.id ??
          null;
      validateMiniFacts(initial);
      validateMiniPlanning(initial);
      validateMiniTeaching(initial);
      validateMiniScheduling(initial);
      validateMiniFlowScheduling(initial);
      if (version < 8 || JSON.stringify(initial) !== JSON.stringify(this.snapshot()))
        this.atomic(() => {
          this.save(initial);
          if (version < 8) {
            const rows = this.db.prepare('SELECT seq,body FROM mini_events').all();
            for (const raw of rows) {
              const row = z.object({ seq: z.number(), body: z.string() }).parse(raw);
              const cleaned = JSON.stringify(withoutMiniPlanMinutes(JSON.parse(row.body)));
              if (cleaned !== row.body)
                this.db
                  .prepare('UPDATE mini_events SET body = ? WHERE seq = ?')
                  .run(cleaned, row.seq);
            }
          }
          this.db.exec('PRAGMA user_version = 8');
        });
      validateMiniFacts(this.snapshot());
      validateMiniPlanning(this.snapshot());
      validateMiniTeaching(this.snapshot());
    } catch (error) {
      this.db.close();
      this.releaseLock();
      throw error;
    }
  }

  snapshot(): MiniSnapshot {
    return miniSnapshotSchema.parse(
      withoutMiniPlanMinutes(
        JSON.parse(
          stateRow.parse(this.db.prepare('SELECT body FROM mini_state WHERE id = 1').get()).body,
        ),
      ),
    );
  }
  planPreview(raw: MiniPlanPreviewInput): MiniPlanPreview {
    const input = miniPlanPreviewInputSchema.parse(raw);
    const snapshot = this.snapshot();
    return { ...snapshot, planContext: miniPlanContext(snapshot, input, swiftTime(this.now())) };
  }
  aiContext(raw: MiniAIContextInput) {
    return miniAIContext(this.snapshot(), raw, swiftTime(this.now()));
  }
  history(raw: MiniHistoryInput) {
    const events: MiniHistoryItem[] = [];
    const rowSchema = z.object({ seq: z.number(), body: z.string(), recorded_at: z.number() });
    for (const rawRow of this.db
      .prepare('SELECT seq,body,recorded_at FROM mini_events ORDER BY seq')
      .all()) {
      const row = rowSchema.parse(rawRow);
      const body = z
        .object({ action: z.object({ type: z.string() }).passthrough() })
        .parse(JSON.parse(row.body));
      if (
        [
          'set_long_term_plan',
          'set_today_plan',
          'clear_today_plan',
          'set_session_plan',
          'clear_session_plan',
          'end_session',
        ].includes(body.action.type)
      )
        events.push({
          id: `command/${row.seq}`,
          kind: 'plan',
          at: row.recorded_at,
          ...('dayId' in body.action && typeof body.action.dayId === 'string'
            ? { dayId: body.action.dayId }
            : {}),
          data: body.action,
        });
    }
    return miniHistoryPage(this.snapshot(), raw, events);
  }
  wordContext(raw: MiniWordContextInput) {
    return miniWordContext(this.snapshot(), raw);
  }
  setAssessmentDiscussionProvider(provider: NonNullable<MiniStore['discussionProvider']>) {
    this.discussionProvider = provider;
  }
  pendingAssessments(): MiniAssessmentSource[] {
    const completed = new Set(
      this.db
        .prepare('SELECT source_id FROM mini_assessment_records')
        .all()
        .map((row) => z.object({ source_id: z.string() }).parse(row).source_id),
    );
    return this.snapshot().assessmentSources.filter((source) => !completed.has(source.id));
  }
  assessmentSource(id: string): MiniAssessmentSource | undefined {
    return this.snapshot().assessmentSources.find((source) => source.id === id.toLowerCase());
  }
  applyAssessment(raw: MiniAssessmentApplication): MiniAssessmentReceipt {
    const application = miniAssessmentApplicationSchema.parse(raw);
    const hash = fingerprint(application);
    return this.atomic(() => {
      const row = this.db
        .prepare(
          'SELECT fingerprint,receipt FROM mini_assessment_records WHERE source_id = ? OR request_id = ?',
        )
        .get(application.source.id, application.requestId);
      if (row) {
        const saved = z.object({ fingerprint: z.string(), receipt: z.string() }).parse(row);
        if (saved.fingerprint !== hash)
          throw new LearningError('MINI_ASSESSMENT_CONFLICT', '评价版本已保存，不能覆盖原结果。');
        return miniAssessmentReceiptSchema.parse(JSON.parse(saved.receipt));
      }
      const state = this.snapshot();
      const source = state.assessmentSources.find((item) => item.id === application.source.id);
      if (
        !source ||
        fingerprint(source) !== fingerprint(application.source) ||
        application.result.inputHash !== fingerprint(source) ||
        application.trace.inputHash !== fingerprint(source) ||
        application.result.sourceId !== source.id
      )
        throw new LearningError(
          'MINI_ASSESSMENT_CONFLICT',
          '评价必须对应已保存的原题、原答和固定证据。',
        );
      const receipt = applyFlowAssessment(state, application, swiftTime(this.now()));
      state.revision += 1;
      validateMiniFlowScheduling(state, [source.word]);
      this.save(state);
      this.db
        .prepare(
          'INSERT INTO mini_assessment_records (source_id,request_id,fingerprint,application,receipt) VALUES (?,?,?,?,?)',
        )
        .run(
          source.id,
          application.requestId,
          hash,
          JSON.stringify(application),
          JSON.stringify(receipt),
        );
      return receipt;
    });
  }
  private assessmentDraft(
    state: MiniSnapshot,
    day: MiniDay,
    attempt: MiniDay['translation'][number],
    capturedAtSubmission: boolean,
  ) {
    const word = attempt.task.sentence.word,
      at = attempt.submittedAt;
    const sessions = state.ledger.days
      .flatMap((item) => [
        ...(item.review ? [item.review] : []),
        ...(item.learning ? [item.learning] : []),
        ...(item.flow?.groups.map((group) => group.spelling) ?? []),
      ])
      .concat(
        [state.reviewRecord, ...state.reviewHistory].flatMap((record) =>
          record ? [record.session] : [],
        ),
      );
    const spelling = sessions
      .flatMap((session) => session.spellingAttempts)
      .filter((item) => sameWord(item.word, word) && item.submittedAt <= at);
    const exposures = state.teaching.exposures.filter(
      (event) => sameWord(event.word, word) && event.at <= at,
    );
    const events = state.ledger.days
      .flatMap((item) => [
        ...(item.flow?.window.events ?? []),
        ...(item.review?.relearning?.events ?? []),
      ])
      .filter((event) => sameWord(event.word, word) && event.confirmedAt <= at);
    const views = state.scheduling.views.filter(
      (event) => sameWord(event.word, word) && event.at <= at,
    );
    // A green answer can remain visible until Next. Its actual confirmation time
    // is a saved command fact, not another independent spelling attempt.
    const confirmations = this.db
      .prepare(
        "SELECT seq, body FROM mini_events WHERE json_extract(body, '$.action.type') = 'advance_spelling'",
      )
      .all()
      .flatMap((raw) => {
        const row = z.object({ seq: z.number(), body: z.string() }).parse(raw);
        const event = z
          .object({ occurredAt: z.number(), action: z.object({ word: miniWordSchema }) })
          .parse(JSON.parse(row.body));
        return sameWord(event.action.word, word) && event.occurredAt <= at
          ? [
              {
                id: `command/${row.seq}`,
                word,
                at: event.occurredAt,
                kind: 'spelling_answer_confirmation',
              },
            ]
          : [];
      });
    const projected = state.scheduling.cards.find((item) =>
      sameWord(item.word, word),
    )?.lastAnswerExposureAt;
    const lastReveal = Math.max(
      -Infinity,
      ...events.flatMap((event) => [
        event.confirmedAt,
        ...(event.revealedAt === undefined ? [] : [event.revealedAt]),
      ]),
      ...spelling.flatMap((item) => [
        item.submittedAt,
        ...(item.revealedAnswerAt === undefined ? [] : [item.revealedAnswerAt]),
      ]),
      ...confirmations.map((event) => event.at),
      ...views.map((event) => event.at),
      ...exposures.map((event) => event.at),
      ...(projected !== undefined && projected !== null && projected <= at ? [projected] : []),
    );
    const intervening =
      sessions.some((session) =>
        session.spellingAttempts.some(
          (event) =>
            !sameWord(event.word, word) && event.submittedAt > lastReveal && event.submittedAt < at,
        ),
      ) ||
      state.ledger.days.some((item) =>
        [...(item.flow?.window.events ?? []), ...(item.review?.relearning?.events ?? [])].some(
          (event) =>
            !sameWord(event.word, word) && event.confirmedAt > lastReveal && event.confirmedAt < at,
        ),
      );
    const eligible =
      capturedAtSubmission &&
      !(projected !== undefined && projected !== null && projected > at) &&
      Number.isFinite(lastReveal) &&
      at - lastReveal >= (intervening ? 60 : 300);
    const context = miniWordContext(state, { word, limit: 50 });
    const priorTranslations = state.ledger.days
      .flatMap((item) => item.translation)
      .filter(
        (item) =>
          item.id !== attempt.id &&
          sameWord(item.task.sentence.word, word) &&
          item.submittedAt <= at,
      )
      .slice(-10)
      .map((item) => ({
        id: item.id,
        task: item.task,
        answer: item.answer,
        submittedAt: item.submittedAt,
        ...(item.confirmedAt !== undefined && item.confirmedAt <= at
          ? { confirmedAt: item.confirmedAt }
          : {}),
        ...(item.gradedAt !== undefined && item.gradedAt <= at
          ? { feedback: item.feedback, gradedAt: item.gradedAt }
          : {}),
      }));
    return assessmentDraftSchema.parse({
      schemaVersion: 1,
      id: attempt.id.toLowerCase(),
      dayId: day.id,
      attemptId: attempt.id.toLowerCase(),
      word,
      timezone: day.timezone ?? this.timezone,
      question: {
        id: attempt.task.materialId ?? attempt.task.id,
        direction: attempt.task.direction,
        english: attempt.task.sentence.english,
        chinese: attempt.task.sentence.chinese,
      },
      answer: attempt.answer,
      submittedAt: at,
      learningEvidence: z.record(z.string(), z.json()).parse({
        flowVersion: day.flow?.version ?? null,
        capturedAtSubmission,
        windowEvents: events.slice(-100),
        spellingAttempts: spelling.slice(-100),
        spellingConfirmations: confirmations.slice(-100),
        exposures: exposures.slice(-100),
        views: views.slice(-100),
        evidenceCounts: {
          windowEvents: events.length,
          memoryFailures: events.filter((event) => !event.remembered).length,
          spellingAttempts: spelling.length,
          firstSpellingErrors: spelling.filter((item) => item.kind === 'first' && !item.correct)
            .length,
          recentRecordLimit: 100,
        },
        wordContext: capturedAtSubmission
          ? {
              ...context,
              memory:
                context.memory &&
                (context.memory.fsrs?.last_review ?? context.memory.introducedAt) <= at
                  ? context.memory
                  : null,
              flowMemory:
                context.flowMemory && context.flowMemory.updatedAt <= at
                  ? context.flowMemory
                  : null,
              probes: context.probes.filter(
                (probe) =>
                  Math.max(
                    probe.openedAt,
                    probe.endedAt ?? -Infinity,
                    probe.submittedAt ?? -Infinity,
                    probe.helpAt ?? -Infinity,
                    probe.revealedAt ?? -Infinity,
                  ) <= at,
              ),
              dictations: context.dictations.filter(
                (item) =>
                  Math.max(
                    item.openedAt,
                    item.closedAt ?? -Infinity,
                    item.revealedAt ?? -Infinity,
                    ...item.attempts.map((attempt) => attempt.submittedAt),
                  ) <= at,
              ),
              focusItems: context.focusItems.filter((item) => item.updatedAt <= at),
              history: {
                ...context.history,
                items: context.history.items.filter((item) => item.at <= at),
              },
            }
          : null,
        priorTranslations,
        priorReviewJudgments: sessions
          .flatMap((session) => session.judgmentEvents)
          .filter(
            (event) =>
              sameWord(event.word, word) &&
              event.selectedAt <= at &&
              (event.finalizedAt === undefined || event.finalizedAt <= at),
          )
          .slice(-30),
        eligibility: {
          meaning: eligible,
          spelling: eligible && attempt.task.direction === 'chineseToEnglish',
          lastAnswerExposureAt: Number.isFinite(lastReveal) ? lastReveal : null,
          reason: !capturedAtSubmission
            ? '旧作答缺少提交时的固定证据，不反推独立回忆资格。'
            : eligible
              ? '提交时固定的答案曝光、帮助与实际间隔证据。'
              : '近期曝光或帮助，评价仅作教学与较近复习依据。',
        },
      }),
    });
  }
  private captureAssessmentSubmission(state: MiniSnapshot, action: MiniCommand['action']) {
    if (action.type !== 'submit_translation' || action.target !== 'daily') return;
    const day = state.ledger.days.find((item) => item.id === action.dayId);
    const attempt = day?.translation.find((item) => item.task.id === action.taskId);
    if (!day?.flow || !attempt) return;
    const draft = this.assessmentDraft(state, day, attempt, true);
    this.db
      .prepare('INSERT OR IGNORE INTO mini_assessment_drafts(attempt_id,body) VALUES (?,?)')
      .run(attempt.id.toLowerCase(), JSON.stringify(draft));
  }
  private freezeAssessments(state: MiniSnapshot) {
    for (const day of state.ledger.days) {
      if (!day.flow) continue;
      for (const attempt of day.translation) {
        if (
          attempt.confirmedAt === undefined ||
          state.assessmentSources.some((source) => source.id === attempt.id.toLowerCase())
        )
          continue;
        const row = this.db
          .prepare('SELECT body FROM mini_assessment_drafts WHERE attempt_id=?')
          .get(attempt.id.toLowerCase());
        const draft = row
          ? assessmentDraftSchema.parse(JSON.parse(stateRow.parse(row).body))
          : this.assessmentDraft(state, day, attempt, false);
        if (
          draft.answer !== attempt.answer ||
          draft.submittedAt !== attempt.submittedAt ||
          draft.dayId !== day.id
        )
          throw new LearningError(
            'MINI_ASSESSMENT_CONFLICT',
            '评分草稿与原始作答不一致，不能覆盖。',
          );
        const source = miniAssessmentSourceSchema.parse({
          ...draft,
          confirmedAt: attempt.confirmedAt,
          discussion:
            this.discussionProvider?.(
              attempt.task.sentence.word,
              attempt.submittedAt,
              attempt.confirmedAt,
            ) ?? [],
        });
        state.assessmentSources.push(source);
      }
    }
  }
  commandReceipt(requestId: string): { requestId: string; revision: number } | null {
    z.uuid().parse(requestId);
    const row = this.db
      .prepare('SELECT revision FROM mini_receipts WHERE request_id = ?')
      .get(requestId.toLowerCase());
    return row
      ? {
          requestId,
          revision: z.object({ revision: z.number().int().nonnegative() }).parse(row).revision,
        }
      : null;
  }
  private atomic<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private replay(requestId: string, hash: string): boolean {
    const row = this.db
      .prepare('SELECT fingerprint FROM mini_receipts WHERE request_id = ?')
      .get(requestId.toLowerCase());
    if (!row) return false;
    if (receiptRow.parse(row).fingerprint !== hash)
      throw new LearningError('REQUEST_CONFLICT', '相同请求身份不能用于不同操作。');
    return true;
  }
  private receipt(requestId: string, hash: string, revision: number) {
    this.db
      .prepare('INSERT INTO mini_receipts (request_id,fingerprint,revision) VALUES (?,?,?)')
      .run(requestId.toLowerCase(), hash, revision);
  }
  private save(snapshot: MiniSnapshot) {
    this.db
      .prepare('UPDATE mini_state SET body = ? WHERE id = 1')
      .run(JSON.stringify(miniSnapshotSchema.parse(snapshot)));
  }
  importLegacy(raw: MiniImport): MiniSnapshot {
    const input = miniImportSchema.parse(raw);
    const { requestId, ...source } = input;
    const hash = fingerprint({ action: 'import', ...source });
    return this.atomic(() => {
      if (this.replay(requestId, hash)) return this.snapshot();
      const current = this.snapshot();
      if (current.imported) {
        const imported = receiptRow.parse(
          this.db.prepare('SELECT fingerprint FROM mini_import WHERE id = 1').get(),
        );
        if (imported.fingerprint !== hash)
          throw new LearningError('MINI_ALREADY_IMPORTED', '旧学习记录已经迁入，不能再次覆盖。');
        this.receipt(requestId, hash, current.revision);
        return current;
      }
      const state: MiniSnapshot = {
        schemaVersion: 1,
        revision: current.revision + 1,
        imported: true,
        ledger: structuredClone(input.ledger),
        reviewRecord: input.reviewRecord,
        reviewHistory: input.reviewHistory,
        planning: current.planning,
        teaching: current.teaching,
        scheduling: current.scheduling,
        practice: current.practice,
        assessmentSources: current.assessmentSources,
      };
      initializeMiniScheduling(state);
      validateMiniFacts(state);
      for (const day of state.ledger.days) day.timezone ??= input.timezone ?? this.timezone;
      state.planning.activeDayId =
        state.ledger.days.find((day) => day.phase !== 'finished' && !day.paused)?.id ??
        [...state.ledger.days].reverse().find((day) => day.phase !== 'finished')?.id ??
        state.ledger.days.at(-1)?.id ??
        null;
      validateMiniPlanning(state);
      validateMiniTeaching(state);
      validateMiniScheduling(state);
      validateMiniFlowScheduling(state);
      this.db
        .prepare('INSERT INTO mini_import (id,fingerprint,body,imported_at) VALUES (1,?,?,?)')
        .run(hash, JSON.stringify(source), swiftTime(this.now()));
      this.save(state);
      this.receipt(requestId, hash, state.revision);
      return state;
    });
  }
  command(raw: MiniCommand): MiniSnapshot {
    return this.executeCommand(raw, 'user');
  }
  aiCommand(raw: MiniCommand, authorization: { sourceMessageId?: string } = {}): MiniSnapshot {
    const command = miniCommandSchema.parse(withoutMiniPlanMinutes(raw));
    if (
      ![
        'set_long_term_plan',
        'set_today_plan',
        'clear_today_plan',
        'set_session_plan',
        'clear_session_plan',
        'end_session',
        'add_sentences',
        'publish_writing',
        'qualitative_feedback',
        'create_focus',
        'update_focus',
        'remember_preference',
        'forget_preference',
        'record_exposure',
        'record_probe_help',
      ].includes(command.action.type)
    )
      throw new LearningError(
        'MINI_AI_ACTION_FORBIDDEN',
        'AI 不能替用户作答、自评或推进学习。',
        403,
      );
    if (command.action.target === 'review' && command.action.type !== 'record_exposure')
      throw new LearningError(
        'MINI_AI_ACTION_FORBIDDEN',
        '这项 AI 教学操作只适用于指定每日学习组。',
        403,
      );
    return this.executeCommand(command, 'ai', authorization);
  }
  private executeCommand(
    raw: MiniCommand,
    actor: 'user' | 'ai',
    authorization: { sourceMessageId?: string } = {},
  ): MiniSnapshot {
    const input = miniCommandSchema.parse(withoutMiniPlanMinutes(raw));
    const hash = fingerprint({
      action: 'command',
      expectedRevision: input.expectedRevision,
      occurredAt: input.occurredAt,
      input: input.action,
    });
    return this.atomic(() => {
      if (this.replay(input.requestId, hash)) return this.snapshot();
      if (
        actor === 'ai' &&
        (input.action.type === 'remember_preference' ||
          input.action.type === 'forget_preference') &&
        authorization.sourceMessageId !== input.action.sourceMessageId
      )
        throw new LearningError(
          'MINI_MEMORY_SOURCE_REQUIRED',
          '稳定偏好必须来自已保存且授权的用户消息。',
          403,
        );
      const state = this.snapshot();
      if (!state.imported)
        throw new LearningError('MINI_IMPORT_REQUIRED', '请先迁入原有学习记录。');
      if (state.revision !== input.expectedRevision)
        throw new LearningError('MINI_REVISION_CONFLICT', '学习进度已更新，请刷新后重试。');
      const before = JSON.stringify(state);
      // This snapshot passed full validation when opened. Trusted mutators only
      // append schedule events; unchanged words do not need another FSRS replay.
      const previousScheduleEventCount = state.scheduling.flow.events.length;
      const receivedAt = swiftTime(this.now());
      if (input.occurredAt !== undefined && input.occurredAt > receivedAt + 300)
        throw new LearningError(
          'MINI_EVENT_TIME_INVALID',
          '学习事件时间超出本机当前时间，请检查系统时钟。',
          400,
        );
      const occurredAt =
        input.action.type === 'begin' || actor === 'ai' || input.action.type === 'record_exposure'
          ? receivedAt
          : (input.occurredAt ?? receivedAt);
      const measurement = applyMiniMeasurementAction(state, input.action, occurredAt, receivedAt);
      if (!measurement) {
        if (!applyMiniTeachingAction(state, input.action, occurredAt))
          applyMiniPlannedAction(state, input.action, occurredAt, receivedAt, this.timezone);
      }
      observeMiniFlowScheduling(state, receivedAt);
      enforceMiniDueGate(state, input.action, receivedAt);
      if (!measurement) observeMiniLearningCommand(state, input.action, occurredAt);
      this.captureAssessmentSubmission(state, input.action);
      this.freezeAssessments(state);
      validateMiniFacts(state);
      validateMiniPlanning(state);
      validateMiniTeaching(state);
      validateMiniScheduling(state);
      validateMiniFlowScheduling(
        state,
        state.scheduling.flow.events.slice(previousScheduleEventCount).map((event) => event.word),
      );
      if (JSON.stringify(state) !== before) {
        state.revision += 1;
        this.save(state);
        this.db
          .prepare(
            'INSERT INTO mini_events (revision,request_id,body,recorded_at) VALUES (?,?,?,?)',
          )
          .run(
            state.revision,
            input.requestId.toLowerCase(),
            JSON.stringify({
              action:
                input.action.type === 'remember_preference'
                  ? { type: input.action.type, target: input.action.target }
                  : input.action,
              occurredAt,
              actor,
            }),
            receivedAt,
          );
      }
      this.receipt(input.requestId, hash, state.revision);
      return state;
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } finally {
      this.releaseLock();
    }
  }
}
