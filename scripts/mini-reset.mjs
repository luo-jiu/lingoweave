import { lstat, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const bundles = new Set(['com.lingoweave.mini', 'com.lingoweave.mini.dev']);
const dbSuffixes = ['', '-wal', '-shm', '-journal'];

async function info(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  }
}

// No caller-supplied relative paths, globbing, recursive scans of Library, or linked ancestors.
export async function validateResetPaths(library, bundle) {
  if (
    !bundles.has(bundle) ||
    !isAbsolute(library) ||
    resolve(library) !== library ||
    basename(library) !== 'Library'
  )
    throw new Error('无效的 Mini 数据目录。');
  const support = join(library, 'Application Support');
  const profile = join(support, bundle);
  const service = join(profile, 'service');
  const data = join(service, 'data');
  for (const directory of [
    library,
    support,
    profile,
    service,
    data,
    join(library, 'Preferences'),
    join(library, 'Caches'),
    join(library, 'HTTPStorages'),
    join(library, 'Saved Application State'),
  ]) {
    const entry = await info(directory);
    if (entry && !entry.isDirectory()) throw new Error('不能安全重置非标准目录：' + directory);
  }
  const vocabulary = join(data, 'mini-vocabulary.sqlite');
  for (const file of [
    ...dbSuffixes.map((s) => vocabulary + s),
    join(library, 'Preferences', bundle + '.plist'),
  ]) {
    const entry = await info(file);
    if (entry && (!entry.isFile() || entry.nlink !== 1))
      throw new Error('不能重置链接的配置或词库：' + file);
  }
  const lock = join(service, 'start.lock');
  const lockEntry = await info(lock);
  if (lockEntry && !lockEntry.isDirectory()) throw new Error('不能验证启动锁。');
  for (const file of [
    join(lock, 'pid'),
    join(lock, 'owner'),
    join(service, 'process.json'),
    join(service, 'token'),
  ]) {
    const entry = await info(file);
    if (entry && (!entry.isFile() || entry.nlink !== 1)) throw new Error('不能验证服务身份文件。');
  }
  return { profile, service, data, vocabulary };
}

function resetBookSelection(filename) {
  const db = new DatabaseSync(filename);
  try {
    if (db.prepare('PRAGMA user_version').get().user_version !== 1)
      throw new Error('无法识别词库版本，已停止重置。');
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = db
        .prepare(
          `UPDATE vocabulary_state SET body=json_set(body,
        '$.activeDeckId', NULL, '$.activeOrder', 'random', '$.revision', 0)
        WHERE id=1 AND json_extract(body, '$.schemaVersion')=1 AND json_type(body, '$.collections')='array'`,
        )
        .run();
      if (result.changes !== 1) throw new Error('词库格式异常，未清空学习记录。');
      db.exec('DELETE FROM vocabulary_requests; COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

// Production holds the per-profile launch lock for this entire operation.
export async function resetStudyData({ library, bundle, assertStopped, resetPreferences }) {
  const { profile, service, data, vocabulary } = await validateResetPaths(library, bundle);
  await assertStopped();
  if (await info(vocabulary)) {
    resetBookSelection(vocabulary);
  } else {
    for (const suffix of dbSuffixes.slice(1)) {
      if (await info(vocabulary + suffix)) throw new Error('词库主文件缺失，已停止重置。');
    }
  }
  await resetPreferences();
  const files = [
    ...['mini', 'mini-ai', 'mini-audio', 'lingoweave'].flatMap((name) =>
      [...dbSuffixes, '.lock'].map((suffix) => join(data, name + '.sqlite' + suffix)),
    ),
    ...['audio', 'agent-workspace', 'mini-agent-workspace', 'mini-assessment-workspace'].map(
      (name) => join(data, name),
    ),
    ...['DailyStudy', 'Review', 'StudyChat.json', 'migration-backup', 'service-client'].map(
      (name) => join(profile, name),
    ),
    join(service, 'service.log'),
    join(library, 'Caches', bundle),
    join(library, 'HTTPStorages', bundle),
    join(library, 'HTTPStorages', bundle + '.binarycookies'),
    join(library, 'Saved Application State', bundle + '.savedState'),
  ];
  for (const file of files) await rm(file, { recursive: true, force: true });
}
