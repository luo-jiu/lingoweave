import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { miniSnapshotSchema } from '../packages/contracts/dist/index.js';
import {
  flowMemory,
  recordFlowSchedule,
  validateMiniFlowScheduling,
} from '../apps/server/dist/mini-flow-scheduler.js';
import { localDay, swiftTime } from '../apps/server/dist/mini-study.js';

const timezone = 'Asia/Shanghai';
const epoch = 978307200;
const firstAt = swiftTime(new Date('2026-11-17T09:00:00+08:00'));
const dateAt = (at) => new Date((at + epoch) * 1000);
const dayAt = (at) => localDay(dateAt(at), timezone);
const dayNumber = (at) => Math.round((Date.parse(dayAt(at)) - Date.parse('2026-11-17')) / 86400000);
const state = () =>
  miniSnapshotSchema.parse({
    schemaVersion: 1,
    revision: 0,
    imported: true,
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
  });
const word = (spelling) => ({ spelling, meaning: '合成调度场景', phonetic: '' });
function record(target, value, sourceId, at, meaning, spelling, extra = {}) {
  recordFlowSchedule(target, {
    id: `${sourceId}/${spelling === null ? 'meaning' : 'spelling'}`,
    sourceId,
    word: value,
    kind: 'review',
    occurredAt: at,
    recordedAt: at,
    timezone,
    meaning,
    spelling,
    evidence: spelling === null ? 'self_report' : 'objective',
    nextDay: false,
    reasons: ['补充事件层：预设合格评级；非真实用户或模型成绩。'],
    ...extra,
  });
}
function complete(target, value, at) {
  recordFlowSchedule(target, {
    id: `complete/${value.spelling}`,
    sourceId: `learn/${value.spelling}`,
    word: value,
    kind: 'completion',
    occurredAt: at,
    recordedAt: at,
    timezone,
    meaning: null,
    spelling: null,
    evidence: 'learning',
    nextDay: true,
    reasons: ['合成完成事件。'],
  });
}
function mature(kind) {
  const target = state();
  const value = word(kind === 'meaning' ? 'mature-meaning' : 'mature-spelling');
  complete(target, value, firstAt);
  const rows = [];
  for (let offset = 1; offset <= 90; offset++) {
    const before = flowMemory(target, value);
    if (dayNumber(before.dueAt) > offset) continue;
    const at = Math.max(firstAt + offset * 86400, before.dueAt);
    const n = rows.length + 1;
    const lapse = n === 4;
    const meaning = lapse && kind === 'meaning' ? 'Again' : 'Good';
    const spelling = lapse && kind === 'spelling' ? 'Again' : 'Good';
    const sourceId = `${value.spelling}/${n}`;
    record(target, value, sourceId, at, meaning, null);
    record(
      target,
      value,
      sourceId,
      at + 305,
      null,
      spelling,
      spelling === 'Again' ? { nextDay: true, reviewCeilingDays: 2 } : {},
    );
    const after = flowMemory(target, value);
    rows.push({
      scenario: value.spelling,
      visit: n,
      appearance_day: offset,
      appearance_date: dayAt(at),
      meaning,
      spelling,
      prior_due: dayAt(before.dueAt),
      ideal_due: dayAt(after.idealDueAt),
      actual_due: dayAt(after.dueAt),
      interval_days: dayNumber(after.dueAt) - offset,
    });
  }
  assert.ok(rows.length > 4);
  assert.ok(
    rows[3].appearance_day - rows[2].appearance_day > 20,
    'Lapse must follow a genuinely longer interval.',
  );
  assert.ok(
    rows[3].interval_days < rows[2].interval_days,
    'The actual scheduler must shorten the mature failed word.',
  );
  validateMiniFlowScheduling(target);
  return rows;
}
function validationCost() {
  const target = state();
  const values = Array.from({ length: 50 }, (_, i) =>
    word(`validation-${String(i).padStart(2, '0')}`),
  );
  for (const value of values) complete(target, value, firstAt);
  for (let offset = 1; offset <= 90; offset++) {
    const due = target.scheduling.flow.cards.filter((card) => dayNumber(card.dueAt) <= offset);
    const at = Math.max(firstAt + offset * 86400, ...due.map((card) => card.dueAt));
    for (const [index, card] of due.entries()) {
      const sourceId = `${card.word.spelling}/${offset}`;
      record(target, card.word, sourceId, at + index * 2, 'Good', null);
      record(target, card.word, sourceId, at + index * 2 + 305, null, 'Good');
    }
  }
  const original = structuredClone(target);
  const durations = { full: [], unchanged: [], oneWord: [] };
  for (let trial = 0; trial < 3; trial++) {
    for (const [name, affected] of [
      ['full', undefined],
      ['unchanged', []],
      ['oneWord', [values[0]]],
    ]) {
      const start = performance.now();
      validateMiniFlowScheduling(target, affected);
      durations[name].push(performance.now() - start);
    }
  }
  assert.deepEqual(target, original, 'Validation must not change dates, ratings or evidence.');
  const measurements = Object.fromEntries(
    Object.entries(durations).map(([name, times]) => {
      const ordered = [...times].sort((a, b) => a - b);
      const round = (value) => Math.round(value * 1000) / 1000;
      return [
        name,
        {
          runs: times.length,
          medianMs: round(ordered[1]),
          minMs: round(ordered[0]),
          maxMs: round(ordered.at(-1)),
        },
      ];
    }),
  );
  return {
    cards: target.scheduling.flow.cards.length,
    events: target.scheduling.flow.events.length,
    changes: target.scheduling.flow.changes.length,
    validationMs: measurements.full.medianMs,
    measurements,
    sampledWord: values[0].spelling,
    sampledWordEvents: target.scheduling.flow.events.filter(
      (event) => event.word.spelling === values[0].spelling,
    ).length,
    layer:
      'actual validateMiniFlowScheduling over one previously full-validated fresh 50-word/90-day event-level state; three paired full/unchanged/single-word runs; excludes MiniStore whole-snapshot validation',
  };
}
export async function appendSchedulingObservations() {
  const base = fileURLToPath(new URL('../docs/research/', import.meta.url));
  const rows = [...mature('meaning'), ...mature('spelling')];
  const cost = validationCost();
  const fields = Object.keys(rows[0]);
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
  await writeFile(
    `${base}mini-scheduling-scenarios/mature-trajectories.csv`,
    [
      fields.map(quote).join(','),
      ...rows.map((row) => fields.map((field) => quote(row[field])).join(',')),
    ].join('\n') + '\n',
  );
  const metadataPath = `${base}mini-scheduling-scenarios/summary.json`;
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  if (metadata.additionalObservations?.mature)
    assert.deepEqual(
      rows,
      metadata.additionalObservations.mature,
      'The validation optimization must preserve both mature lapse trajectories.',
    );
  metadata.additionalObservations = {
    mature: rows,
    validationCost: cost,
    checks: [
      'mature meaning lapse follows a >20-day gap and shortens actual due',
      'mature spelling lapse follows a >20-day gap and shortens actual due',
      '50-card final scheduling projection matches full event replay',
      'full, unchanged and single-word validation preserve all scheduling facts',
      ...(metadata.additionalObservations?.mature
        ? ['both mature lapse trajectories equal the earlier generated report']
        : []),
    ],
  };
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
  const reportPath = `${base}mini-scheduling-scenarios-2026-11-17.md`;
  let report = await readFile(reportPath, 'utf8');
  report = report.replace(
    /<!-- supplemental-observations:start -->[\s\S]*?<!-- supplemental-observations:end -->\n*/u,
    '',
  );
  const section = `<!-- supplemental-observations:start -->
## 长间隔后遗忘或拼错，再恢复

另补两类事件层用例：前三次双维度 Good，第四次（已经过较长间隔）分别让 meaning Again、spelling Again，随后恢复 Good。这里直接输入已分类评级，使用真实调度器；不是重新走全部 UI 命令。出现日期仍由实际 due 决定。

| 场景 | 第几次 | 出现日 | meaning/spelling | 理想 due | 实际 due | 下次间隔 |
| --- | ---: | ---: | --- | --- | --- | ---: |
${rows.map((row) => `| ${row.scenario} | ${row.visit} | D${row.appearance_day} | ${row.meaning}/${row.spelling} | ${row.ideal_due} | ${row.actual_due} | ${row.interval_days} |`).join('\n')}

成熟词不是继续沿用原来的长间隔：两种失败都缩短了 due，随后按恢复表现重新拉长。完整记录见 [成熟词轨迹](mini-scheduling-scenarios/mature-trajectories.csv)。

## 性能与需要留意的结果

已保存的 19 类轨迹试跑中，真实命令各类 p95 的最大值为 ${Math.max(...metadata.summaries.map((item) => item.commandTiming.p95ms))}ms，最慢一次命令 ${Math.max(...metadata.summaries.map((item) => item.commandTiming.maxMs))}ms。随后在同一份隔离的 **50 词、90 天、${cost.events} 条调度事件** 上，对三种校验范围各实测 3 次：

| validateMiniFlowScheduling 范围 | 中位耗时（ms） | 最小～最大（ms） |
| --- | ---: | --- |
| 默认全量；重新打开时使用 | ${cost.measurements.full.medianMs} | ${cost.measurements.full.minMs}～${cost.measurements.full.maxMs} |
| []；此次命令没有新增调度事件 | ${cost.measurements.unchanged.medianMs} | ${cost.measurements.unchanged.minMs}～${cost.measurements.unchanged.maxMs} |
| [word]；本次只影响一个词（${cost.sampledWordEvents} 条历史事件） | ${cost.measurements.oneWord.medianMs} | ${cost.measurements.oneWord.minMs}～${cost.measurements.oneWord.maxMs} |

日常命令的增量校验以已完整校验的内存状态为前提，仍检查全局身份与关联，并重放新增事件涉及的词；打开数据库时继续完整重放。脚本断言三种校验都没有修改任何日期、评级或证据，${metadata.additionalObservations.checks.includes('both mature lapse trajectories equal the earlier generated report') ? '两条成熟词轨迹与先前报告逐项一致。' : '两条成熟词轨迹按同一调度公式生成。'}19 类主轨迹和负荷数据沿用已完成的试跑，没有因这次校验性能调整重新生成。以上只测调度校验，**350 词的完整 MiniStore 学习历史保存尚未做规模压测**，不能据此承诺长期 UI 延迟。

- 初学只错一次的 2 天上限，本例首次 Good 本来也给 2 天，故轨迹和全对相同；三次错误或目标翻译拼写错误的 1 天上限才明显提早。它是上限，不保证每个小错误都改变日期。
- 每次在初选前听例句，都属于 meaning 受帮助；当前保守规则可能让它每天回来。**正常自动读英文单词，以及初选确认之后才展开朗读例句，不会因此取消已作出的 meaning Good。** 本用例有意测的是初选之前提供句子帮助。
- 350 词组给定“每天确实完成 50 新词”的输入，用来观察负荷叠加；不模拟是否有时间先清完到期复习再完成这些新词。实际应用仍要求先清复习，这个给定新增量未必每天可实现。

<!-- supplemental-observations:end -->

`;
  report = report.replace('## 断言与局限\n', section + '## 断言与局限\n');
  await writeFile(reportPath, report);
  process.stdout.write(
    `supplement: 2 mature lapse cases; ${cost.cards} cards/${cost.events} events validation median full=${cost.validationMs}ms unchanged=${cost.measurements.unchanged.medianMs}ms oneWord=${cost.measurements.oneWord.medianMs}ms\n`,
  );
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  await appendSchedulingObservations();
