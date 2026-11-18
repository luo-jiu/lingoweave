import { appendSchedulingObservations } from './mini-scheduling-observations.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MiniStore } from '../apps/server/dist/mini-store.js';
import {
  currentMiniWindow,
  currentTranslation,
  localDay,
  swiftTime,
} from '../apps/server/dist/mini-study.js';
import {
  flowMemory,
  nextFlowDay,
  recordFlowSchedule,
  validateMiniFlowScheduling,
} from '../apps/server/dist/mini-flow-scheduler.js';
import { miniSnapshotSchema } from '../packages/contracts/dist/index.js';

// Synthetic scenarios only. No app data, login, network, inference or TTS is opened.
// Layer A executes the real MiniStore command/observer path against private :memory: SQLite.
// Layer B calls the actual scheduling event API for a larger fixed-input load experiment.
const timezone = 'Asia/Shanghai';
const firstDate = '2026-11-17';
const horizon = 90;
const seed = 20261117;
const epoch = 978307200;
const firstAt = swiftTime(new Date(`${firstDate}T09:00:00+08:00`));
const outDirectory = fileURLToPath(
  new URL('../docs/research/mini-scheduling-scenarios/', import.meta.url),
);
const reportPath = fileURLToPath(
  new URL('../docs/research/mini-scheduling-scenarios-2026-11-17.md', import.meta.url),
);
const dateAt = (at) => new Date((at + epoch) * 1000);
const dayAt = (at) => localDay(dateAt(at), timezone);
const dayNumber = (at) =>
  Math.round(
    (Date.parse(`${dayAt(at)}T00:00:00Z`) - Date.parse(`${firstDate}T00:00:00Z`)) / 86400000,
  );
const round = (value) => Math.round(value * 1000) / 1000;
let identity = 0;
function id() {
  const hash = createHash('sha256').update(`${seed}/${identity++}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
const checks = [];
function checked(name, assertion) {
  assertion();
  checks.push(name);
}
const baselineBehavior = { judgment: 'clear', spellingErrors: 0, delay: 305 };
const scenarios = [
  { id: 'steady-clear', word: 'apple', title: '持续清晰，独立拼写正确' },
  {
    id: 'always-fuzzy',
    word: 'bridge',
    title: '每次初见模糊，下一轮清晰',
    behavior: () => ({ judgment: 'fuzzy' }),
  },
  {
    id: 'always-forgotten',
    word: 'cloud',
    title: '每次三轮遗忘，拼写三轮首答错',
    behavior: () => ({ judgment: 'forgotten', judgmentMisses: 3, spellingErrors: 3 }),
  },
  {
    id: 'recover-after-errors',
    word: 'garden',
    title: '前两次复习错误，随后恢复',
    behavior: (n) => (n <= 2 ? { judgment: 'forgotten', spellingErrors: 1 } : {}),
  },
  {
    id: 'memory-one-reset',
    word: 'river',
    title: '初学记忆退回 0 一次，后来全对',
    memoryErrors: 1,
  },
  {
    id: 'memory-three-resets',
    word: 'window',
    title: '初学记忆退回 0 三次，后来全对',
    memoryErrors: 3,
  },
  {
    id: 'initial-spelling-one',
    word: 'ticket',
    title: '初学拼写一轮首答错，后来全对',
    initialSpellingErrors: 1,
  },
  {
    id: 'initial-spelling-three',
    word: 'bottle',
    title: '初学拼写三轮首答错，后来全对',
    initialSpellingErrors: 3,
  },
  {
    id: 'translation-spelling-error',
    word: 'bag',
    title: '目标词翻译拼写错误，后来全对',
    assessment: 'spelling-error',
  },
  {
    id: 'translation-meaning-error',
    word: 'bright',
    title: '目标词翻译词义错误，后来全对',
    assessment: 'meaning-error',
  },
  {
    id: 'supported-translation-success',
    word: 'travel',
    title: '支持条件下翻译正确',
    assessment: 'correct',
  },
  { id: 'uncertain-assessment', word: 'light', title: '模型评价不确定', assessment: 'uncertain' },
  { id: 'absence-seven-days', word: 'school', title: '停学 7 天后回归', absentThrough: 7 },
  { id: 'absence-thirty-days', word: 'street', title: '停学 30 天后回归', absentThrough: 30 },
  {
    id: 'late-assessment',
    word: 'bag',
    title: '错误评价在首次复习后才到达',
    assessment: 'spelling-error',
    late: true,
  },
  { id: 'same-day-probe', word: 'paper', title: '学习当天额外独立拼写成功', probe: true },
  {
    id: 'word-audio',
    word: 'water',
    title: '复习初选前读英文单词',
    behavior: () => ({ audioKind: 'word' }),
  },
  {
    id: 'sentence-audio',
    word: 'coffee',
    title: '复习初选前听例句',
    behavior: () => ({ audioKind: 'sentence' }),
  },
  {
    id: 'recent-spelling-support',
    word: 'table',
    title: '清晰后立即拼写，无独立拼写资格',
    behavior: () => ({ delay: 0 }),
  },
];

function runner(specification) {
  let now = firstAt;
  const word = {
    spelling: specification.word,
    meaning: `模拟义项：${specification.word}`,
    phonetic: '',
  };
  // The first helper word gives the target an actual Chinese-to-English task.
  const helper = { spelling: 'support', meaning: '辅助词（独立模拟记录）', phonetic: '' };
  const deck = [helper, word];
  const store = new MiniStore(':memory:', { timezone, now: () => dateAt(now) });
  let projection;
  const commandTimes = [];
  const snapshot = () => projection ?? store.snapshot();
  const day = () => {
    const state = snapshot();
    const value = state.ledger.days.find((item) => item.id === state.planning.activeDayId);
    assert.ok(value);
    return value;
  };
  const context = () => ({ target: 'daily', dayId: day().id });
  const action = (command) => {
    now += 1;
    const commandStart = performance.now();
    const result = store.command({
      requestId: id(),
      expectedRevision: snapshot().revision,
      action: command,
    });
    commandTimes.push(performance.now() - commandStart);
    return result;
  };
  store.importLegacy({
    requestId: id(),
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
    timezone,
  });
  action({
    type: 'set_long_term_plan',
    target: 'daily',
    plan: {
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      wordLimit: 1,
      newWordLimit: 1,

      dailyNewGoal: 2,
      groupSize: 2,
    },
  });
  const begin = () =>
    action({ type: 'begin', target: 'daily', deck, timezone, flowVersion: 'sliding-window-v2' });
  function memory(session = 'learning', misses = 0) {
    for (let count = 0; count < 200; count++) {
      const visit = currentMiniWindow(day())?.visit;
      if (!visit) return;
      const ctx = { ...context(), session, word: visit.word, visitId: visit.id };
      const remembered = !(
        visit.word.spelling === word.spelling &&
        visit.stage > 0 &&
        misses-- > 0
      );
      if (visit.stage === 0) action({ ...ctx, type: 'window_advance', remembered });
      else {
        action({ ...ctx, type: 'window_choose', remembered });
        action({ ...ctx, type: 'window_advance' });
      }
    }
    throw new Error('Synthetic memory visits failed to settle.');
  }
  function spelling(session, errors = 0, delay = 0) {
    now += delay;
    for (let count = 0; count < 50; count++) {
      const current = day()[session];
      if (current?.phase === 'finished') return;
      assert.equal(current?.phase, 'spelling');
      const target = current.queue[0];
      assert.ok(target);
      const ctx = { ...context(), session, word: target };
      if (current.spellingState === 'readyToAdvance' || current.spellingState === 'skipped')
        action({ ...ctx, type: 'advance_spelling' });
      else {
        const firsts = current.spellingAttempts.filter(
          (item) => item.word.spelling === target.spelling && item.kind === 'first',
        ).length;
        const wrong =
          target.spelling === word.spelling &&
          current.spellingState === 'awaitingFirst' &&
          firsts < errors;
        action({
          ...ctx,
          type: 'submit_spelling',
          answer: wrong ? `wrong-${firsts}` : target.spelling,
          advanceOnCorrect: false,
        });
      }
    }
    throw new Error('Synthetic spelling rounds failed to settle.');
  }
  function teach() {
    begin();
    action({
      ...context(),
      type: 'add_sentences',
      sentences: deck.map((target) => ({
        word: target,
        english: `This is ${target.spelling}.`,
        chinese: '这是教学例句。',
      })),
    });
    memory('learning', specification.memoryErrors ?? 0);
    spelling('learning', specification.initialSpellingErrors ?? 0);
    action({
      ...context(),
      type: 'publish_writing',
      prompts: day().flow.translationWords.map((target, index) => ({
        id: id(),
        sentence: {
          word: target,
          english: `Please use ${target.spelling} today.`,
          chinese: '请今天使用这个词。',
        },
        direction: day().directions[index],
        focusIds: [],
      })),
    });
    action({ ...context(), type: 'complete_learning' });
    while (day().phase === 'translation') {
      const task = currentTranslation(day());
      assert.ok(task);
      const target = task.sentence.word.spelling === word.spelling;
      if (target) assert.equal(task.direction, 'chineseToEnglish');
      const answer =
        target && specification.assessment === 'spelling-error'
          ? `Please use ${word.spelling.slice(0, -1)}x today.`
          : target && specification.assessment === 'meaning-error'
            ? 'Please leave it yesterday.'
            : task.direction === 'chineseToEnglish'
              ? task.sentence.english
              : task.sentence.chinese;
      action({ ...context(), type: 'submit_translation', taskId: task.id, answer });
      action({ ...context(), type: 'advance_translation', taskId: task.id });
    }
    assert.equal(day().phase, 'finished');
    assert.equal(snapshot().ledger.days.flatMap((entry) => entry.flow?.completed ?? []).length, 2);
  }
  function assess() {
    const source = store
      .pendingAssessments()
      .find((entry) => entry.word.spelling === word.spelling);
    assert.ok(source);
    const hash = createHash('sha256').update(JSON.stringify(source)).digest('hex');
    const observation = (ability) => ({
      outcome:
        specification.assessment === 'uncertain'
          ? 'uncertain'
          : specification.assessment === `${ability}-error`
            ? 'incorrect'
            : 'correct',
      explanation: `模拟模型明确判断 ${ability}；不是实际模型推理。`,
      evidenceIds: [source.attemptId],
    });
    const input = {
      requestId: id(),
      source,
      result: {
        sourceId: source.id,
        inputHash: hash,
        meaning: observation('meaning'),
        spelling: observation('spelling'),
        usage: observation('usage'),
        summary: '固定的模拟模型结果。',
        strengths: [],
        improvements: [],
        referenceTranslation: source.question.english,
        uncertainties: specification.assessment === 'uncertain' ? ['模拟题目语义不确定。'] : [],
      },
      trace: {
        model: 'simulated-result-no-model-call',
        effort: 'xhigh',
        threadId: null,
        rulesVersion: 'mini-assessment-v1',
        skillHash: '0'.repeat(64),
        promptHash: '0'.repeat(64),
        inputHash: hash,
        startedAt: now,
        assessedAt: now,
      },
    };
    const beforeAbility = flowMemory(snapshot(), word);
    const receipt = store.applyAssessment(input);
    const after = snapshot();
    assert.deepEqual(store.applyAssessment(input), receipt);
    assert.deepEqual(snapshot(), after);
    assert.equal(source.learningEvidence.eligibility.meaning, false);
    assert.deepEqual(
      flowMemory(snapshot(), word)?.meaning,
      beforeAbility?.meaning,
      'Recent supported answers must not create FSRS successes/failures.',
    );
    assert.deepEqual(flowMemory(snapshot(), word)?.spelling, beforeAbility?.spelling);
    return receipt;
  }
  function sameDayProbe() {
    now += 600;
    const original = flowMemory(snapshot(), word).dueAt;
    action({ type: 'begin_probe', target: 'daily', word });
    const probeId = snapshot().scheduling.activeProbeId;
    assert.ok(probeId);
    action({ type: 'submit_probe', target: 'daily', probeId, answer: word.spelling });
    action({ type: 'end_probe', target: 'daily', probeId });
    assert.equal(flowMemory(snapshot(), word)?.dueAt, original);
    assert.equal(
      snapshot().scheduling.probes.find((probe) => probe.id === probeId)?.rating,
      'Good',
    );
  }
  function review(behavior) {
    begin();
    assert.equal(day().phase, 'review');
    const originalId = day().id;
    const containsTarget = day().reviewWords.some((item) => item.spelling === word.spelling);
    for (
      let count = 0;
      count < 20 && day().review?.phase === 'judgment' && day().review?.queue.length;
      count++
    ) {
      const current = day().review;
      const target = current.queue[0];
      const targetVisit = target.spelling === word.spelling;
      const previous = current.judgmentEvents.filter(
        (entry) => entry.word.spelling === target.spelling,
      ).length;
      if (targetVisit && previous === 0 && behavior.audioKind)
        action({
          ...context(),
          session: 'review',
          type: 'record_exposure',
          word: target,
          kind: 'potentialHelp',
          source: 'audio',
          audioKind: behavior.audioKind,
          focusIds: [],
        });
      const judgment =
        targetVisit &&
        previous < (behavior.judgmentMisses ?? (behavior.judgment === 'clear' ? 0 : 1))
          ? behavior.judgment
          : 'clear';
      action({ ...context(), session: 'review', type: 'choose_judgment', word: target, judgment });
      action({
        ...context(),
        session: 'review',
        type: 'advance_judgment',
        word: target,
        markWrong: false,
      });
    }
    if (currentMiniWindow(day())?.visit) memory('review');
    spelling('review', behavior.spellingErrors, behavior.delay);
    action({ ...context(), type: 'complete_review' });
    assert.equal(day().phase, 'finished');
    const events = snapshot().scheduling.flow.events.filter(
      (entry) =>
        entry.kind === 'review' &&
        entry.sourceId === originalId &&
        entry.word.spelling === word.spelling,
    );
    return { containsTarget, events };
  }
  function reviewProjection() {
    projection ??= store.snapshot();
    const due = projection.scheduling.flow.cards.filter((card) => card.dueAt <= now);
    const result = [];
    for (const prior of due) {
      const previous = projection.scheduling.flow.events.filter(
        (event) => event.kind === 'review' && event.word.spelling === prior.word.spelling,
      );
      const latest = previous.at(-1);
      assert.ok(latest);
      const templates = previous.filter((event) => event.sourceId === latest.sourceId);
      const sourceId = `repeat/${specification.id}/${dayNumber(now)}/${prior.word.spelling}`;
      for (const [index, template] of templates.entries()) {
        const base = swiftTime(new Date(`${dayAt(template.occurredAt)}T09:00:00+08:00`));
        const { load, ...raw } = template;
        void load;
        recordFlowSchedule(projection, {
          ...raw,
          id: `${sourceId}/${index}`,
          sourceId,
          occurredAt: now + template.occurredAt - base,
          recordedAt: now + template.recordedAt - base,
          reasons: [
            ...template.reasons.filter((reason) => !reason.startsWith('重复模式层：')),
            '重复模式层：沿用前 14 天真实命令产出的固定评级组合。',
          ],
        });
        if (prior.word.spelling === word.spelling)
          result.push(projection.scheduling.flow.events.at(-1));
      }
    }
    return { containsTarget: result.length > 0, events: result };
  }
  return {
    word,
    snapshot,
    reviewProjection,
    get layer() {
      return projection ? 'scheduler-repeat-after-day14' : 'actual-ministore';
    },
    get commandTiming() {
      const sorted = [...commandTimes].sort((a, b) => a - b);
      return {
        count: sorted.length,
        p50ms: round(sorted[Math.floor(sorted.length * 0.5)] ?? 0),
        p95ms: round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
        maxMs: round(sorted.at(-1) ?? 0),
      };
    },
    teach,
    assess,
    review,
    sameDayProbe,
    close: () => store.close(),
    get now() {
      return now;
    },
    set now(value) {
      now = value;
    },
  };
}

const trajectories = [];
const summaries = [];
const checkpoints = new Map();
function trajectory(spec, run, kind, events, performance, priorDue = null) {
  const card = flowMemory(run.snapshot(), run.word);
  assert.ok(card);
  const times = events.map((event) => event.occurredAt);
  const occurredAt = times.length ? Math.min(...times) : run.now;
  const row = {
    scenario: spec.id,
    layer: run.layer,
    word: spec.word,
    kind,
    day: dayNumber(occurredAt),
    appearance_date: dayAt(occurredAt),
    occurred_at: dateAt(occurredAt).toISOString(),
    original_performance: performance,
    meaning_rating:
      events
        .map((entry) => entry.meaning)
        .filter(Boolean)
        .join('+') || 'none',
    spelling_rating:
      events
        .map((entry) => entry.spelling)
        .filter(Boolean)
        .join('+') || 'none',
    evidence: [...new Set(events.map((entry) => entry.evidence))].join('+'),
    prior_due_date: priorDue === null ? '' : dayAt(priorDue),
    overdue_days: priorDue === null ? 0 : Math.max(0, dayNumber(occurredAt) - dayNumber(priorDue)),
    ideal_due: dayAt(card.idealDueAt),
    actual_due: dayAt(card.dueAt),
    interval_days: dayNumber(card.dueAt) - dayNumber(occurredAt),
    interval_hours: round((card.dueAt - occurredAt) / 3600),
    meaning_reps: card.meaning?.reps ?? 0,
    spelling_reps: card.spelling?.reps ?? 0,
    reason: events.flatMap((entry) => entry.reasons).join('；'),
  };
  trajectories.push(row);
  return row;
}

for (const spec of scenarios) {
  const scenarioStarted = performance.now();
  const run = runner(spec);
  try {
    run.teach();
    const completion = run
      .snapshot()
      .scheduling.flow.events.filter(
        (entry) => entry.kind === 'completion' && entry.word.spelling === spec.word,
      );
    trajectory(
      spec,
      run,
      'completion',
      completion,
      `记忆错误${spec.memoryErrors ?? 0}次；拼写首答错${spec.initialSpellingErrors ?? 0}轮`,
    );
    checked(`${spec.id}: actual completion schedules next local day without invented FSRS`, () => {
      assert.equal(flowMemory(run.snapshot(), run.word).dueAt, nextFlowDay(run.now, timezone));
      assert.equal(flowMemory(run.snapshot(), run.word).meaning, null);
      assert.equal(flowMemory(run.snapshot(), run.word).spelling, null);
    });
    if (spec.assessment && !spec.late) {
      run.assess();
      trajectory(
        spec,
        run,
        'assessment',
        run
          .snapshot()
          .scheduling.flow.events.filter(
            (entry) => entry.kind === 'assessment' && entry.word.spelling === spec.word,
          ),
        spec.assessment,
      );
    }
    if (spec.probe) {
      run.sameDayProbe();
      trajectory(
        spec,
        run,
        'probe',
        run.snapshot().scheduling.flow.events.filter((entry) => entry.kind === 'probe'),
        '同日独立拼写正确',
      );
      checks.push('same-day probe Good cannot postpone mandatory tomorrow review');
    }
    const absenceBefore = JSON.stringify(run.snapshot());
    let reviews = 0;
    for (let offset = 1; offset <= horizon; offset++) {
      run.now = firstAt + offset * 86400;
      if (offset <= (spec.absentThrough ?? 0)) {
        assert.equal(JSON.stringify(run.snapshot()), absenceBefore);
        continue;
      }
      const state = run.snapshot();
      const due = state.scheduling.flow.cards.filter((card) => dayNumber(card.dueAt) <= offset);
      if (!due.length) continue;
      run.now = Math.max(run.now, ...due.map((card) => card.dueAt));
      const targetDue = flowMemory(state, run.word).dueAt;
      const behavior = { ...baselineBehavior, ...spec.behavior?.(reviews + 1) };
      const repeated = offset > 14 && ['always-forgotten', 'sentence-audio'].includes(spec.id);
      const result = repeated ? run.reviewProjection() : run.review(behavior);
      if (!result.containsTarget) continue;
      assert.ok(targetDue <= run.now, 'Targets must appear only when actually due.');
      reviews++;
      const row = trajectory(
        spec,
        run,
        'review',
        result.events,
        `初见${behavior.judgment}；拼写首答错${behavior.spellingErrors}轮；间隔${behavior.delay}s${behavior.audioKind ? `；${behavior.audioKind}音频` : ''}`,
        targetDue,
      );
      if (spec.late && reviews === 1) {
        run.now += 4 * 3600;
        const before = flowMemory(run.snapshot(), run.word);
        run.assess();
        const after = flowMemory(run.snapshot(), run.word);
        assert.deepEqual(after.meaning, before.meaning);
        assert.deepEqual(after.spelling, before.spelling);
        checkpoints.set('late', after);
        trajectory(
          spec,
          run,
          'late_assessment',
          run
            .snapshot()
            .scheduling.flow.events.filter(
              (entry) => entry.kind === 'assessment' && entry.word.spelling === spec.word,
            ),
          '原完成日的错误评价在首次真实复习之后到达',
        );
      }
      if (spec.id === 'translation-spelling-error' && reviews === 1)
        checkpoints.set('early', flowMemory(run.snapshot(), run.word));
      assert.ok(row.interval_days >= 1, 'Completed review cannot require another same-day loop.');
    }
    validateMiniFlowScheduling(run.snapshot());
    const actualRows = trajectories.filter(
      (row) => row.scenario === spec.id && row.kind === 'review',
    );
    summaries.push({
      id: spec.id,
      word: spec.word,
      title: spec.title,
      commandTiming: run.commandTiming,
      elapsedSeconds: round((performance.now() - scenarioStarted) / 1000),
      reviews,
      firstReviewDay: actualRows[0]?.day ?? null,
      firstIntervals: actualRows.slice(0, 8).map((row) => row.interval_days),
      appearanceDays: actualRows.map((row) => row.day),
      nextDue: dayAt(flowMemory(run.snapshot(), run.word).dueAt),
      finalMeaningReps: flowMemory(run.snapshot(), run.word).meaning?.reps ?? 0,
      finalSpellingReps: flowMemory(run.snapshot(), run.word).spelling?.reps ?? 0,
    });
    process.stdout.write(
      `scenario ${spec.id}: ${reviews} target reviews; days ${actualRows
        .slice(0, 10)
        .map((row) => row.day)
        .join(',')}; intervals ${actualRows
        .slice(0, 8)
        .map((row) => row.interval_days)
        .join(',')}; command p95 ${run.commandTiming.p95ms}ms\n`,
    );
  } finally {
    run.close();
  }
}

checked(
  'late assessment preserves later real ability state and matches chronological adoption',
  () => {
    const early = checkpoints.get('early'),
      late = checkpoints.get('late');
    assert.ok(early && late);
    for (const field of ['meaning', 'spelling', 'dueAt', 'idealDueAt', 'updatedAt'])
      assert.deepEqual(late[field], early[field], field);
  },
);
checked('absence produces a later first appearance without fabricated intervening reviews', () => {
  assert.equal(summaries.find((item) => item.id === 'absence-seven-days').firstReviewDay, 8);
  assert.equal(summaries.find((item) => item.id === 'absence-thirty-days').firstReviewDay, 31);
});
checked('word audio keeps meaning success while sentence audio remains supported', () => {
  const wordRows = trajectories.filter(
    (row) => row.scenario === 'word-audio' && row.kind === 'review',
  );
  const sentenceRows = trajectories.filter(
    (row) => row.scenario === 'sentence-audio' && row.kind === 'review',
  );
  assert.ok(wordRows.every((row) => row.meaning_rating === 'Good'));
  assert.ok(sentenceRows.every((row) => row.meaning_rating === 'none'));
});
checked('short supported spelling is not another independent successful repetition', () => {
  assert.equal(
    summaries.find((item) => item.id === 'recent-spelling-support').finalSpellingReps,
    0,
  );
});

function seededRandom(initial) {
  let state = initial >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}
function cohort(name, mixed = false, absent = false, newDays = 1) {
  const state = miniSnapshotSchema.parse({
    schemaVersion: 1,
    revision: 0,
    imported: true,
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
  });
  const random = seededRandom(seed);
  const targets = Array.from({ length: 50 * newDays }, (_, index) => ({
    spelling: `cohort${String(index).padStart(2, '0')}`,
    meaning: '固定合成词义',
    phonetic: '',
  }));
  const visits = new Map();
  const daily = [];
  const eventRows = [];
  for (let offset = 0; offset <= horizon; offset++) {
    const at = firstAt + offset * 86400;
    if (offset < newDays) {
      for (let index = offset * 50; index < (offset + 1) * 50; index++) {
        recordFlowSchedule(state, {
          id: `${name}/completion/${index}`,
          sourceId: `${name}/learn/${index}`,
          word: targets[index],
          kind: 'completion',
          occurredAt: at,
          recordedAt: at,
          timezone,
          meaning: null,
          spelling: null,
          evidence: 'learning',
          nextDay: true,
          reasons: [`负荷模拟：第 ${offset} 日真实输入 50 词已完成事件。`],
        });
      }
    }
    const due = state.scheduling.flow.cards
      .filter((card) => dayNumber(card.dueAt) <= offset)
      .sort((a, b) => a.dueAt - b.dueAt || a.word.spelling.localeCompare(b.word.spelling));
    const skipped = absent && offset >= 8 && offset <= 14;
    const beforeEvents = state.scheduling.flow.events.length;
    if (!skipped)
      for (const [slot, prior] of due.entries()) {
        const n = (visits.get(prior.word.spelling) ?? 0) + 1;
        visits.set(prior.word.spelling, n);
        const roll = random();
        const rating = mixed ? (roll < 0.1 ? 'Again' : roll < 0.3 ? 'Hard' : 'Good') : 'Good';
        const spelling = mixed && roll < 0.1 ? 'Again' : 'Good';
        const occurred = Math.max(at, ...due.map((card) => card.dueAt)) + slot * 2;
        const sourceId = `${name}/review/${offset}/${prior.word.spelling}`;
        assert.ok(prior.dueAt <= occurred);
        recordFlowSchedule(state, {
          id: sourceId,
          sourceId,
          word: prior.word,
          kind: 'review',
          occurredAt: occurred,
          recordedAt: occurred + 305,
          timezone,
          meaning: rating,
          spelling: null,
          evidence: 'self_report',
          nextDay: false,
          reasons: [`固定种子合成复习：${rating}，非真实用户表现。`],
        });
        recordFlowSchedule(state, {
          id: `${sourceId}/spelling`,
          sourceId,
          word: prior.word,
          kind: 'review',
          occurredAt: occurred + 305,
          recordedAt: occurred + 305,
          timezone,
          meaning: null,
          spelling,
          evidence: 'objective',
          nextDay: spelling === 'Again',
          ...(spelling === 'Again' ? { reviewCeilingDays: 2 } : {}),
          reasons: ['负荷层输入已合格的独立拼写评级；评级采集本身由单词层测试。'],
        });
        const after = flowMemory(state, prior.word);
        assert.ok(after);
        const shift = Math.abs(dayNumber(after.dueAt) - dayNumber(after.idealDueAt));
        assert.ok(shift <= 3);
        eventRows.push({
          cohort: name,
          word: prior.word.spelling,
          appearance_day: offset,
          appearance_date: dayAt(occurred),
          prior_due: dayAt(prior.dueAt),
          original_performance: `${rating}/${spelling}`,
          ideal_due: dayAt(after.idealDueAt),
          actual_due: dayAt(after.dueAt),
          interval_days: dayNumber(after.dueAt) - offset,
          shift_days: dayNumber(after.dueAt) - dayNumber(after.idealDueAt),
        });
      }
    if (skipped) assert.equal(state.scheduling.flow.events.length, beforeEvents);
    daily.push({
      cohort: name,
      day: offset,
      date: dayAt(at),
      due_before: due.length,
      reviewed: skipped ? 0 : due.length,
      skipped,
      pending_after: state.scheduling.flow.cards.filter((card) => dayNumber(card.dueAt) <= offset)
        .length,
      new_completions: offset < newDays ? 50 : 0,
      total_word_tasks: (skipped ? 0 : due.length) + (offset < newDays ? 50 : 0),
    });
  }
  checked(
    `${name}: ${50 * newDays} completion inputs, first-day peak preserved and no fake completion on reviews`,
    () => {
      assert.equal(
        state.scheduling.flow.events.filter((event) => event.kind === 'completion').length,
        50 * newDays,
      );
      assert.equal(daily[1].due_before, 50);
      assert.equal(daily[1].reviewed, 50);
      assert.equal(
        state.ledger.days.length,
        0,
        'The load experiment does not pretend event-level inputs are UI learning records.',
      );
    },
  );
  validateMiniFlowScheduling(state);
  const later = daily.filter((entry) => entry.day > 1);
  return {
    name,
    mixed,
    absent,
    newDays,
    daily,
    events: eventRows,
    summary: {
      completedWords: targets.length,
      peakTotalWordTasks: Math.max(...daily.map((entry) => entry.total_word_tasks)),
      totalReviews: daily.reduce((sum, item) => sum + item.reviewed, 0),
      firstReviewPeak: daily[1].reviewed,
      laterPeak: Math.max(...later.map((item) => item.reviewed)),
      activeDays: daily.filter((item) => item.reviewed > 0).length,
      averagePerDay: round(daily.reduce((sum, item) => sum + item.reviewed, 0) / horizon),
      futureDateCount: new Set(state.scheduling.flow.cards.map((card) => dayAt(card.dueAt))).size,
      shiftedReviews: eventRows.filter((row) => row.shift_days !== 0).length,
      returnDayLoad: absent ? daily[15].due_before : null,
    },
  };
}
const cohorts = [
  cohort('all-clear'),
  cohort('mixed-performance', true),
  cohort('mixed-with-break', true, true),
  cohort('fifty-per-day-seven-days', true, false, 7),
];
checked(
  'load balancing actually changes some eligible dates without erasing the first mandatory peak',
  () => assert.ok(cohorts[0].summary.shiftedReviews > 0),
);

function csv(rows) {
  if (!rows.length) return '';
  const fields = Object.keys(rows[0]);
  const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return (
    [
      fields.map(quote).join(','),
      ...rows.map((row) => fields.map((field) => quote(row[field])).join(',')),
    ].join('\n') + '\n'
  );
}
const singleTable = summaries
  .map(
    (item) =>
      `| ${item.title}（${item.word}） | ${item.reviews} | ${item.appearanceDays.slice(0, 9).join('、')}${item.appearanceDays.length > 9 ? '…' : ''} | ${item.firstIntervals.slice(0, 7).join('、')} | ${item.nextDue} |`,
  )
  .join('\n');
const loadTable = cohorts
  .map(
    (item) =>
      `| ${item.name} | ${item.summary.completedWords} | ${item.summary.peakTotalWordTasks} | ${item.summary.firstReviewPeak} | ${item.summary.laterPeak} | ${item.summary.totalReviews} | ${item.summary.activeDays} | ${item.summary.averagePerDay} | ${item.summary.shiftedReviews} |`,
  )
  .join('\n');
const dailyTable = Array.from(
  { length: 31 },
  (_, day) =>
    `| ${day} | ${cohorts
      .map((item) => {
        const value = item.daily[day];
        return value.skipped ? `停学；积压 ${value.due_before}` : String(value.reviewed);
      })
      .join(' | ')} |`,
).join('\n');
const rowsFor = (name) =>
  trajectories.filter((row) => row.scenario === name && row.kind === 'review');
const strong = summaries.find((item) => item.id === 'steady-clear');
const weak = summaries.find((item) => item.id === 'always-forgotten');
const fuzzy = summaries.find((item) => item.id === 'always-fuzzy');
const typical = [
  'steady-clear',
  'always-fuzzy',
  'recover-after-errors',
  'initial-spelling-three',
  'late-assessment',
]
  .flatMap((name) =>
    rowsFor(name)
      .slice(0, 5)
      .map(
        (row) =>
          `| ${name} | ${row.appearance_date} | ${row.meaning_rating}/${row.spelling_rating} | ${row.ideal_due} | ${row.actual_due} | ${row.interval_days} |`,
      ),
  )
  .join('\n');
const metadata = {
  date: firstDate,
  horizonDays: horizon,
  seed,
  timezone,
  nodeVersion: process.version,
  library: 'ts-fsrs@5.4.2/FSRS-6',
  policy: 'mini-flow-scheduling-v1',
  layers: {
    single:
      'actual MiniStore commands/observers; always-forgotten and sentence-audio use first 14 days actual commands then repeat measured event templates via the actual scheduler; synthetic answers/model results',
    cohort:
      'actual recordFlowSchedule/replay; deterministic prequalified ratings; no UI, learner or inference',
  },
  checks,
  summaries,
  cohorts: cohorts.map(({ name, summary, daily }) => ({ name, summary, daily })),
};
const report = `# mini 复习曲线场景检查（2026-11-17）

这次检查直接执行当前已编译的业务代码和锁定的 FSRS-6，观察不同真实输入类型如何改变出现日期。它是**规则模拟，不是真实记忆效果或 AI 批改准确率实验**。没有读取个人数据、调用模型或生成声音。

## 方法与复现

- 起点：${firstDate} 09:00，时区 ${timezone}；观察 ${horizon} 天，D0 为学习日，D1 为下一自然日。
- 固定 seed：${seed}；运行环境 ${process.version}，算法 ts-fsrs@5.4.2 / mini-flow-scheduling-v1。使用现有默认参数，脚本不复制调度公式。
- 单词层：${scenarios.length} 类场景经真正的 MiniStore、内存 SQLite、窗口/拼写/翻译命令、评价采用与调度观察器执行。极弱词和始终先听句子的两类固定重复模式，前 14 天走实际命令，D15 起沿用该词实际产出的评级组合调用真实调度器；不复制评级或 FSRS 公式，CSV 的 layer 明确区分。每个场景有一个辅助词，保证目标取得真实中译英题；辅助词照常复习，但下表只计目标词。
- 负荷层：3 组各 50 词同日完成，另 1 组连续 7 天每天完成 50 词（共 350 词）；以真实 recordFlowSchedule 和重放器运行 90 天。这里输入已经分好类的模拟评级，避免把大规模事件输入误称为实际 UI 作答；拼写独立资格的采集另由单词层覆盖。
- 每天在 09:00 或当天实际 due 到达后取词；不会把 09:00:02 到期误算成要再等一天，只选实际 due 已到的词；停学日不写事件、不补完成。正常拼写在反馈隐藏至少 305 秒后进行；“近期拼写支持”场景立即输入。单词/句子音频场景写真实业务曝光命令，不运行 TTS；真实播放授权的正确性另有音频集成测试。
- 模拟模型结果明确标记为 simulated-result-no-model-call。保存/重试/采用经过真实边界，结果内容由脚本预设。

复现：在仓库根目录执行 \`pnpm --filter @lingoweave/contracts build\`、\`pnpm --filter @lingoweave/server build\`，再执行 \`node scripts/test-mini-scheduling-scenarios.mjs\`。脚本使用私有内存数据库；随机内部 UUID 不进入导出字段，固定行为和 seed 决定轨迹；实测耗时会随运行环境变化。

## 单词出现日与间隔

出现日列为 D0 之后的日号，非“预先安排的手填日期”。间隔为当地日历差；原始小时差、原表现、采用理由、理想/实际日期全部保存在 [单词轨迹 CSV](mini-scheduling-scenarios/single-trajectories.csv)。

| 场景 | 90 天目标复习次数 | 实际出现日（前若干次） | 每次之后的间隔（天，前若干次） | 最后一次算出的下次 due |
| --- | ---: | --- | --- | --- |
${singleTable}

可直接读出的差别：持续清晰/正确出现 ${strong.reviews} 次，长期模糊出现 ${fuzzy.reviews} 次，反复遗忘出现 ${weak.reviews} 次。这里输入了这些表现，不能倒过来解释成模型预测了真实用户会忘多少。

## 典型逐次记录

Good/Hard/Again 分别为实际采用评级；none 表示该维度本次没有合格更新，不是错误，也不是零分。理想 due 与实际 due 的差别来自真实有界错峰策略。

| 场景 | 出现日期 | meaning/spelling | 理想 due | 实际 due | 日历间隔 |
| --- | --- | --- | --- | --- | ---: |
${typical}

迟到用例把 D0 的目标拼写错误评价延后至 D1 首次复习之后再采用。D1 复习提交当时先排到 D3，随后旧评分回补将下一次改为 D2，因此表中首次间隔为 2、下一次却在 D2 出现并非漏测；评分采用不是额外一次复习。脚本比较它与按顺序采用的能力卡、理想/实际 due，结果一致；D1 已保存的真实复习未被覆盖。支持下正确和不确定评价不新增独立 FSRS 次数；初学困难通过保守上限表达。普通复习英文已显示时，读词保持 meaning Good，但句子音频阻止无帮助 meaning 成功；音频仍计入拼写曝光。

| 迟到评价的事件 | 采用前 due | 采用后 due | 是否计为复习 |
| --- | --- | --- | --- |
| D1 的实际复习 | D1 已到期 | ${rowsFor('late-assessment')[0].actual_due}（D3） | 是 |
| D1 回补 D0 的错误评分 | ${rowsFor('late-assessment')[0].actual_due}（D3） | ${trajectories.find((row) => row.kind === 'late_assessment').actual_due}（D2） | 否 |

## 50 词同日与连续新增的 90 天负荷

all-clear 全部持续 Good；mixed-performance 用固定随机序列分配 70% Good、20% Hard、10% Again，Again 同时含独立拼写错误；mixed-with-break 使用同一概率和 seed，但 D8～D14 停学。fifty-per-day-seven-days 在 D0～D6 每天增加 50 个完成词，随后不再增加，复习沿用混合表现。概率只是固定输入假设，不是拟合用户的遗忘率。负荷层把当日事件放在固定短时间区间，独立资格已由输入明确提供；不模拟真实完成全部任务所需时长。

| 场景 | 完成新词总数 | 单日新词+复习最大 | D1 必须复习 | D2～D90 单日最大 | 复习总词次 | 有复习的天数 | 每日平均词次 | 实际发生错峰的词次 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${loadTable}

D1 的 50 词峰值完全保留，首次次日规则不允许把它平摊到未来。后续才在有资格的日期范围内分散。全对组 D3 仍有 50 词：首次 Good 给出的 2 天间隔尚不满足错峰条件，所以不能把“有错峰”理解为完全消除后续高峰。停学组 D15 的实际积压为 ${cohorts[2].summary.returnDayLoad} 词；系统没有在停学日假装完成它们。完整逐日结果见 [每日负荷 CSV](mini-scheduling-scenarios/daily-load.csv)，逐词 due 见 [群组轨迹 CSV](mini-scheduling-scenarios/cohort-trajectories.csv)。

| 日号 | 持续全对 | 混合表现 | 混合表现且停学 | 连续 7 天新增 50（仅复习词次） |
| --- | ---: | ---: | --- | ---: |
${dailyTable}

## 断言与局限

真实命令计时包含边界校验、事件观察、SQLite 保存；每类的 p50/p95/max 与耗时保存在 JSON。它是连续压测耗时，受本机同时运行的程序影响，不是基准测试。

本次运行通过 ${checks.length} 项命名检查，另在每次真实业务提交和负荷事件后执行代码自身校验。重点包括：实际 due 才出现；首次次日不被同日 probe 推走；支持与不确定结果不造独立成功/失败；重复采用不改状态；迟到结果与顺序采用一致；停学不产生事件；完成数等于明确输入的 50 或 350，没有由复习伪造新词完成；错峰最多偏移 3 个自然日。检查名与汇总保存在 [JSON](mini-scheduling-scenarios/summary.json)。

持续清晰的最后一个 163 天间隔，是 D60 在距上次 46 天之后仍然真实 Good 时的当前公式输出；不是连续点击四次就放到半年后。这里只是固定输入模拟，仍需实际使用验证个人适配。

当前规则存在明确取舍：

1. 50 词同日学完就会有次日 50 词，初学峰值不可避免；若想让首日也均匀，需要减少/分散新词学习日期，不能靠算法悄悄违背“每词次日复习”。
2. 三轮仍遗忘或反复首答错误会频繁出现，极弱词可能天天回来；这是当前保守策略，不是已证明的个人最佳训练量。窗口阶段错误不会自动腾位，实际教学中还可能卡在窗口，负荷层只接受已完成输入，不能掩盖这种成本。
3. 独立拼写需要真实间隔。本轮 305 秒条件是为了观察双能力，实际 mini 快速做题常只有 meaning 自报更新；立即拼写正确不能冒充独立 spelling Good。
4. 所有到期复习清完才新词会在停学后阻挡新增，这是用户设定的规则。错峰只有局部缓冲能力，不能保证固定每日上限，也不能消除积压。
5. 一次初学错误的 2 天上限，在本例与首次 Good 的默认 2 天重合，不保证轨迹一定不同；三次错误的 1 天上限才明确提早。1/2 天困难上限、次日规则、错峰半径和自报 Good/Hard/Again 是产品策略；程序稳定执行它们不证明它们最优。模型、使用时长、主观判断和声音帮助在真实使用中都有变化。
6. 连续新增组共完成 350 词，90 天实际复习 ${cohorts[3].summary.totalReviews} 词次，单日新词加复习最大 ${cohorts[3].summary.peakTotalWordTasks} 词。该组明确输入新增完成事件；它不是算法凭空补加新词，也不把复习次数算作完成词数。错峰无法消除学习量不断叠加的成本。

相关实现：[调度器](../../apps/server/src/mini-flow-scheduler.ts)、[场景脚本](../../scripts/test-mini-scheduling-scenarios.mjs)。测量边界见 [测量规则](../measurement-rules.md)，产品策略与研究证据区分见 [调度研究](learning-scheduler.md)。
`;

await mkdir(outDirectory, { recursive: true });
await writeFile(`${outDirectory}/single-trajectories.csv`, csv(trajectories));
await writeFile(`${outDirectory}/daily-load.csv`, csv(cohorts.flatMap((entry) => entry.daily)));
await writeFile(
  `${outDirectory}/cohort-trajectories.csv`,
  csv(cohorts.flatMap((entry) => entry.events)),
);
await writeFile(`${outDirectory}/summary.json`, JSON.stringify(metadata, null, 2) + '\n');
await writeFile(reportPath, report);
const packageInfo = JSON.parse(
  await readFile(new URL('../apps/server/package.json', import.meta.url), 'utf8'),
);
assert.equal(packageInfo.dependencies['ts-fsrs'], '5.4.2');
process.stdout.write(
  `wrote ${reportPath}\n${checks.length} named assertions; ${trajectories.length} single rows; ${cohorts.reduce((sum, entry) => sum + entry.events.length, 0)} cohort reviews\n`,
);

await appendSchedulingObservations();
