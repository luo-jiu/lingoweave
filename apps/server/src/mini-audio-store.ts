import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  miniAudioAssetSchema,
  miniAudioJobSchema,
  miniAudioPlaybackReceiptSchema,
  miniAudioRequestSchema,
  miniAudioSnapshotSchema,
  miniCommandSchema,
  miniAudioProfileSchema,
  miniAudioTargetSchema,
  type MiniAudioAsset,
  type MiniAudioJob,
  type MiniAudioPlayback,
  type MiniAudioPlaybackReceipt,
  type MiniAudioRequest,
  type MiniAudioResult,
  type MiniAudioSnapshot,
  type MiniAudioVoice,
  type MiniCommand,
} from '@lingoweave/contracts';
import { LearningError } from './learning-store.js';
import { swiftTime } from './mini-study.js';

const bodyRow = z.object({ body: z.string() });
const referenceSchema = z.object({
  targetKey: z.string(),
  jobId: z.string().nullable(),
  assetId: z.string().nullable(),
});
const inputSchema = z.object({
  profile: miniAudioProfileSchema,
  instructions: z.string(),
  text: z.string(),
  normalizedText: z.string(),
  target: miniAudioTargetSchema,
});
const pendingSchema = z.object({
  input: z.unknown(),
  receipt: miniAudioPlaybackReceiptSchema,
  command: miniCommandSchema.nullable(),
});
export type AudioGenerationInput = z.infer<typeof inputSchema>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const busy = (job: MiniAudioJob) => job.status === 'queued' || job.status === 'running';

export class MiniAudioStore {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(
    filename: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    try {
      if (filename !== ':memory:') chmodSync(filename, 0o600);
      const version = z
        .object({ user_version: z.number().int() })
        .parse(this.db.prepare('PRAGMA user_version').get()).user_version;
      if (version > 1) throw new Error('Audio data was created by a newer LingoWeave version.');
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS audio_state(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audio_requests(id TEXT PRIMARY KEY,hash TEXT NOT NULL,result TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audio_current(target_key TEXT PRIMARY KEY,asset_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audio_inputs(id TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audio_authorizations(id TEXT PRIMARY KEY,hash TEXT NOT NULL,body TEXT NOT NULL);
        PRAGMA user_version=1;`);
      this.db
        .prepare('INSERT OR IGNORE INTO audio_state(id,body) VALUES(1,?)')
        .run(
          JSON.stringify({ schemaVersion: 1, revision: 0, assets: [], jobs: [], playbacks: [] }),
        );
      this.raw();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private raw(): MiniAudioSnapshot {
    return miniAudioSnapshotSchema.parse(
      JSON.parse(
        bodyRow.parse(this.db.prepare('SELECT body FROM audio_state WHERE id=1').get()).body,
      ),
    );
  }
  snapshot(): MiniAudioSnapshot {
    const state = this.raw();
    return { ...state, jobs: state.jobs.slice(-100), playbacks: state.playbacks.slice(-200) };
  }
  jobs() {
    return this.raw().jobs;
  }
  assets() {
    return this.raw().assets;
  }
  private atomic<T>(operation: (state: MiniAudioSnapshot) => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.raw();
      const before = JSON.stringify(state);
      const result = operation(state);
      if (JSON.stringify(state) !== before) {
        state.revision++;
        this.db
          .prepare('UPDATE audio_state SET body=? WHERE id=1')
          .run(JSON.stringify(miniAudioSnapshotSchema.parse(state)));
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private previous(id: string, input: unknown): string | null {
    const row = this.db
      .prepare('SELECT hash,result FROM audio_requests WHERE id=?')
      .get(id.toLowerCase());
    if (!row) return null;
    const previous = z.object({ hash: z.string(), result: z.string() }).parse(row);
    if (previous.hash !== hash(input))
      throw new LearningError('REQUEST_CONFLICT', '相同请求身份不能用于不同音频操作。');
    return previous.result;
  }
  private remember(id: string, input: unknown, result: string) {
    this.db
      .prepare('INSERT INTO audio_requests(id,hash,result) VALUES(?,?,?)')
      .run(id.toLowerCase(), hash(input), result);
  }
  job(id: string): MiniAudioJob {
    const value = this.raw().jobs.find((job) => job.id === id.toLowerCase());
    if (!value) throw new LearningError('AUDIO_JOB_NOT_FOUND', '找不到这项音频任务。', 404);
    return value;
  }
  asset(id: string): MiniAudioAsset {
    const value = this.raw().assets.find((asset) => asset.id === id.toLowerCase());
    if (!value) throw new LearningError('AUDIO_ASSET_NOT_FOUND', '找不到这份音频。', 404);
    return value;
  }
  current(targetKey: string): MiniAudioAsset | null {
    const row = this.db
      .prepare('SELECT asset_id FROM audio_current WHERE target_key=?')
      .get(targetKey);
    return row ? this.asset(z.object({ asset_id: z.string() }).parse(row).asset_id) : null;
  }
  input(id: string): AudioGenerationInput {
    return inputSchema.parse(
      JSON.parse(
        bodyRow.parse(this.db.prepare('SELECT body FROM audio_inputs WHERE id=?').get(id)).body,
      ),
    );
  }
  private result(reference: z.infer<typeof referenceSchema>, reused: boolean): MiniAudioResult {
    const job = reference.jobId ? this.job(reference.jobId) : null;
    const assetId = job?.assetId ?? reference.assetId;
    return {
      targetKey: reference.targetKey,
      asset: assetId ? this.asset(assetId) : null,
      job,
      reused,
    };
  }
  replayRequest(input: MiniAudioRequest): MiniAudioResult | null {
    const previous = this.previous(input.requestId, input);
    return previous ? this.result(referenceSchema.parse(JSON.parse(previous)), true) : null;
  }
  request(
    raw: MiniAudioRequest,
    targetKey: string,
    generation: AudioGenerationInput,
    voice: MiniAudioVoice,
    existing: MiniAudioAsset | null,
  ): { result: MiniAudioResult; dispatch: boolean } {
    const input = miniAudioRequestSchema.parse(raw);
    return this.atomic((state) => {
      const replay = this.replayRequest(input);
      if (replay) return { result: replay, dispatch: false };
      let job: MiniAudioJob | null = null,
        dispatch = false;
      if (input.operation === 'regenerate' || !existing) {
        job = state.jobs.find((job) => job.targetKey === targetKey && busy(job)) ?? null;
        if (job && input.operation === 'regenerate' && input.voice && job.voice !== input.voice)
          throw new LearningError('AUDIO_BUSY', '这份音频正在生成，请完成后再更换声线。');
        if (!job) {
          const at = swiftTime(this.now());
          job = miniAudioJobSchema.parse({
            id: randomUUID(),
            requestId: input.requestId,
            targetKey,
            target: input.target,
            operation: input.operation,
            voice,
            status: 'queued',
            progress: '等待生成…',
            error: null,
            assetId: null,
            createdAt: at,
            updatedAt: at,
          });
          state.jobs.push(job);
          this.db
            .prepare('INSERT INTO audio_inputs(id,body) VALUES(?,?)')
            .run(job.id, JSON.stringify(inputSchema.parse(generation)));
          dispatch = true;
        }
      }
      const reference = { targetKey, jobId: job?.id ?? null, assetId: existing?.id ?? null };
      this.remember(input.requestId, input, JSON.stringify(reference));
      return { result: { targetKey, asset: existing, job, reused: !dispatch }, dispatch };
    });
  }
  update(
    id: string,
    status: MiniAudioJob['status'],
    progress: string,
    error: string | null = null,
  ) {
    return this.atomic((state) => {
      const job = state.jobs.find((job) => job.id === id);
      if (!job) throw new LearningError('AUDIO_JOB_NOT_FOUND', '找不到这项音频任务。', 404);
      job.status = status;
      job.progress = progress;
      job.error = error;
      job.updatedAt = swiftTime(this.now());
      return job;
    });
  }
  complete(id: string, raw: MiniAudioAsset) {
    const asset = miniAudioAssetSchema.parse(raw);
    return this.atomic((state) => {
      const job = state.jobs.find((job) => job.id === id);
      if (!job) throw new LearningError('AUDIO_JOB_NOT_FOUND', '找不到这项音频任务。', 404);
      if (job.status === 'completed') return job;
      state.assets.push(asset);
      this.db
        .prepare(
          'INSERT INTO audio_current(target_key,asset_id) VALUES(?,?) ON CONFLICT(target_key) DO UPDATE SET asset_id=excluded.asset_id',
        )
        .run(job.targetKey, asset.id);
      job.assetId = asset.id;
      job.status = 'completed';
      job.progress = '音频已就绪';
      job.error = null;
      job.updatedAt = swiftTime(this.now());
      return job;
    });
  }
  authorization(
    input: MiniAudioPlayback,
  ): { receipt: MiniAudioPlaybackReceipt; command: MiniCommand | null } | null {
    const row = this.db
      .prepare('SELECT hash,body FROM audio_authorizations WHERE id=?')
      .get(input.requestId);
    if (!row) return null;
    const value = z.object({ hash: z.string(), body: z.string() }).parse(row);
    if (value.hash !== hash(input))
      throw new LearningError('REQUEST_CONFLICT', '相同播放请求不能用于不同词卡或音频。');
    const pending = pendingSchema.parse(JSON.parse(value.body));
    const saved = this.raw().playbacks.find((item) => item.id === pending.receipt.id);
    return { receipt: saved ?? pending.receipt, command: pending.command };
  }
  prepareAuthorization(
    input: MiniAudioPlayback,
    command: MiniCommand | null,
  ): MiniAudioPlaybackReceipt {
    return this.atomic(() => {
      const previous = this.authorization(input);
      if (previous) return previous.receipt;
      const receipt: MiniAudioPlaybackReceipt = {
        id: randomUUID(),
        requestId: input.requestId,
        assetId: input.assetId,
        visitId: input.visitId,
        status: 'authorized',
        authorizedAt: swiftTime(this.now()),
        startedAt: null,
        learningRevision: null,
      };
      this.db
        .prepare('INSERT INTO audio_authorizations(id,hash,body) VALUES(?,?,?)')
        .run(input.requestId, hash(input), JSON.stringify({ input, receipt, command }));
      return receipt;
    });
  }
  pendingAuthorizations() {
    return this.db
      .prepare('SELECT body FROM audio_authorizations')
      .all()
      .map((row) => pendingSchema.parse(JSON.parse(bodyRow.parse(row).body)))
      .filter((item) => !this.raw().playbacks.some((saved) => saved.id === item.receipt.id));
  }
  confirmAuthorization(id: string, revision: number | null): MiniAudioPlaybackReceipt {
    return this.atomic((state) => {
      const row = bodyRow.parse(
        this.db.prepare('SELECT body FROM audio_authorizations WHERE id=?').get(id),
      );
      const value = pendingSchema.parse(JSON.parse(row.body));
      const previous = state.playbacks.find((item) => item.id === value.receipt.id);
      if (previous) return previous;
      value.receipt.learningRevision = revision;
      state.playbacks.push(value.receipt);
      return value.receipt;
    });
  }
  playback(id: string): MiniAudioPlaybackReceipt {
    const result = this.raw().playbacks.find((item) => item.id === id);
    if (!result) throw new LearningError('AUDIO_PLAYBACK_NOT_FOUND', '播放请求尚未确认。', 404);
    return result;
  }
  replayStarted(input: { requestId: string; playbackId: string; occurredAt: number }) {
    const previous = this.previous(input.requestId, { type: 'started', ...input });
    return previous ? this.playback(previous) : null;
  }
  startPlayback(input: {
    requestId: string;
    playbackId: string;
    occurredAt: number;
  }): MiniAudioPlaybackReceipt {
    return this.atomic((state) => {
      const previous = this.previous(input.requestId, { type: 'started', ...input });
      if (previous) return this.playback(previous);
      const playback = state.playbacks.find((item) => item.id === input.playbackId);
      if (!playback) throw new LearningError('AUDIO_PLAYBACK_NOT_FOUND', '播放请求尚未确认。', 404);
      if (playback.startedAt !== null && playback.startedAt !== input.occurredAt)
        throw new LearningError('AUDIO_PLAYBACK_CONFLICT', '已经保存的播放开始时间不能改写。');
      playback.status = 'started';
      playback.startedAt = input.occurredAt;
      this.remember(input.requestId, { type: 'started', ...input }, playback.id);
      return playback;
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
