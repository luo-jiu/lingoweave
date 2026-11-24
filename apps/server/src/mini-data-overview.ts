import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  miniDataOverviewSchema,
  miniDataStorageKindSchema,
  type MiniDataOverview,
  type MiniDataStorageKind,
} from '@lingoweave/contracts';
import type { MiniStore } from './mini-store.js';
import type { MiniAiStore } from './mini-ai-store.js';
import type { MiniAudioStore } from './mini-audio-store.js';
import type { MiniAssessmentStore } from './mini-assessment-store.js';
import type { MiniVocabularyStore } from './mini-vocabulary-store.js';
import { miniCompletedWordKeys } from './mini-vocabulary-store.js';
import { miniSavedReviewVisits } from './mini-memory.js';
import { miniFactHistory } from './mini-teaching.js';
import { localDay, swiftTime, unixDate, wordKey } from './mini-study.js';
import { LearningError } from './learning-store.js';

export interface MiniDataOverviewOptions {
  store: MiniStore;
  dataDirectory: string;
  ai?: MiniAiStore;
  audio?: MiniAudioStore;
  assessment?: MiniAssessmentStore;
  vocabulary?: MiniVocabularyStore;
  serviceLog?: string;
  now?: () => Date;
  timezone?: string;
}

function missing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function regularFileSize(path: string): Promise<number | null> {
  try {
    const info = await lstat(path);
    return info.isFile() ? info.size : null;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

async function dataFiles(directory: string): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  const directories = [directory];
  while (directories.length) {
    const current = directories.pop();
    if (current === undefined) break;
    try {
      // lstat deliberately excludes links, including a linked root or directory.
      if (!(await lstat(current)).isDirectory()) {
        if (current === directory)
          throw new LearningError('MINI_DATA_DIRECTORY_INVALID', '本机数据目录暂不可用。', 503);
        continue;
      }
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) directories.push(path);
        else if (entry.isFile()) {
          const bytes = await regularFileSize(path);
          if (bytes !== null) files.set(path, bytes);
        }
      }
    } catch (error) {
      if (current === directory || !missing(error)) throw error;
    }
  }
  return files;
}

function storageKind(path: string, directory: string, serviceLog: string): MiniDataStorageKind {
  if (path === serviceLog) return 'serviceLog';
  const name = relative(directory, path);
  if (name.startsWith(`audio${sep}`)) return 'audioFiles';
  if (name.startsWith(`materials${sep}`)) return 'materials';
  if (name.startsWith(`vocabulary${sep}`)) return 'vocabulary';
  if (/^mini\.sqlite(?:-(?:wal|shm|journal))?$/.test(name)) return 'learning';
  if (/^mini-ai\.sqlite(?:-(?:wal|shm|journal))?$/.test(name)) return 'ai';
  if (/^mini-audio\.sqlite(?:-(?:wal|shm|journal))?$/.test(name)) return 'audioIndex';
  if (/^mini-vocabulary\.sqlite(?:-(?:wal|shm|journal))?$/.test(name)) return 'vocabulary';
  return 'other';
}

export async function miniDataOverview(
  options: MiniDataOverviewOptions,
): Promise<MiniDataOverview> {
  const asOf = swiftTime((options.now ?? (() => new Date()))());
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const directory = resolve(options.dataDirectory);
  const serviceLog = resolve(options.serviceLog ?? join(dirname(directory), 'service.log'));
  const snapshot = options.store.snapshot();
  const metrics = options.store.dataMetrics();
  const completedWords = miniCompletedWordKeys(snapshot.ledger);
  for (const event of snapshot.scheduling.flow.events)
    if (event.kind === 'completion') completedWords.add(wordKey(event.word));
  const reviewVisits = [...miniSavedReviewVisits(snapshot).values()].reduce(
    (sum, item) => sum + item.ids.size,
    0,
  );
  const dayTimezones = new Map(
    snapshot.ledger.days.map((day) => [day.id, day.timezone ?? timezone]),
  );
  const activityKinds = new Set([
    'judgment',
    'view',
    'spelling',
    'translation',
    'probe',
    'dictation',
    'memory',
    'spelling_skip',
  ]);
  const studyDays = new Set(
    miniFactHistory(snapshot)
      .filter(
        (item) =>
          activityKinds.has(item.kind) &&
          item.at <= asOf &&
          (item.kind !== 'view' || item.data.evidence === 'marked_studied'),
      )
      .map((item) => localDay(unixDate(item.at), dayTimezones.get(item.dayId ?? '') ?? timezone)),
  );
  const translations = new Set(
    snapshot.ledger.days.flatMap((day) => day.translation.map((attempt) => attempt.id)),
  );
  const assessmentJobs = options.assessment?.dataMetrics() ?? [];
  const completedAssessments = new Set(metrics.completedAssessmentIds);
  for (const job of assessmentJobs)
    if (job.status === 'completed') completedAssessments.add(job.sourceId);
  const failedAssessments = new Set(
    assessmentJobs
      .filter((job) => job.status === 'failed' && !completedAssessments.has(job.sourceId))
      .map((job) => job.sourceId),
  );
  const pendingAssessments = new Set(
    snapshot.assessmentSources
      .filter((source) => !completedAssessments.has(source.id) && !failedAssessments.has(source.id))
      .map((source) => source.id),
  );
  for (const job of assessmentJobs)
    if (
      (job.status === 'queued' || job.status === 'running') &&
      !completedAssessments.has(job.sourceId)
    )
      pendingAssessments.add(job.sourceId);
  const ai = options.ai?.dataMetrics() ?? { conversations: 0, messages: 0 };
  const audio = options.audio?.dataMetrics();
  const vocabulary = options.vocabulary?.dataMetrics() ?? { books: 0, entries: 0 };
  const files = await dataFiles(directory);
  if (!files.has(serviceLog)) {
    const bytes = await regularFileSize(serviceLog);
    if (bytes !== null) files.set(serviceLog, bytes);
  }
  const referencedAudio = new Set(
    (audio?.assets ?? []).map((asset) => join(directory, 'audio', asset.fileName)),
  );
  const actualAudio = new Set(
    [...files.keys()].filter((path) => relative(directory, path).startsWith(`audio${sep}`)),
  );
  const storage = miniDataStorageKindSchema.options.map((kind) => ({ kind, bytes: 0 }));
  for (const [path, bytes] of files) {
    const category = storage.find((item) => item.kind === storageKind(path, directory, serviceLog));
    if (category) category.bytes += bytes;
  }
  return miniDataOverviewSchema.parse({
    schemaVersion: 1,
    asOf,
    dataPath: directory,
    learning: {
      completedWords: completedWords.size,
      reviewVisits,
      studyDays: studyDays.size,
      events: metrics.events,
      translations: translations.size,
    },
    ai: {
      ...ai,
      completedAssessments: completedAssessments.size,
      pendingAssessments: pendingAssessments.size,
      failedAssessments: failedAssessments.size,
    },
    audio: {
      wordAssets: audio?.wordAssets ?? 0,
      sentenceAssets: audio?.sentenceAssets ?? 0,
      currentAssets: audio?.currentAssets ?? 0,
      previousAssets: audio?.previousAssets ?? 0,
      missingFiles: [...referencedAudio].filter((path) => !actualAudio.has(path)).length,
      unreferencedFiles: [...actualAudio].filter(
        (path) => /^[a-z0-9-]+\.wav$/.test(basename(path)) && !referencedAudio.has(path),
      ).length,
      pendingJobs: audio?.pendingJobs ?? 0,
      failedJobs: audio?.failedJobs ?? 0,
    },
    vocabulary,
    storage,
  });
}
