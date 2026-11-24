import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../apps/server/dist/app.js';
import { CodexBridge } from '../apps/server/dist/codex/bridge.js';
import { MiniStore } from '../apps/server/dist/mini-store.js';
import { MiniAssessmentStore } from '../apps/server/dist/mini-assessment-store.js';
import { MiniAssessmentService } from '../apps/server/dist/mini-assessment-service.js';
import {
  currentMiniWindow,
  currentTranslation,
  miniPreparationWords,
  miniWritingWords,
} from '../apps/server/dist/mini-study.js';

// Explicit live acceptance only. All learner actions and model outputs belong to
// temporary SQLite files; no personal learning/chat service is used.
const directory = await mkdtemp(join(tmpdir(), 'lingoweave-assessment-live-'));
const studyFile = join(directory, 'mini.sqlite'),
  taskFile = join(directory, 'mini-ai.sqlite');
const timezone = 'Asia/Shanghai';
let executable = process.env.CODEX_BIN;
if (!executable) {
  const bundled =
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  try {
    await access(bundled, constants.X_OK);
    executable = bundled;
  } catch {
    executable = 'codex';
  }
}
const study = new MiniStore(studyFile, { timezone });
const tasks = new MiniAssessmentStore(taskFile);
const runtime = new CodexBridge({
  executable,
  cwd: join(directory, 'workspace'),
  turnTimeoutMs: 360_000,
});
const assessment = new MiniAssessmentService(
  {
    pending: () => study.pendingAssessments(),
    get: (id) => study.assessmentSource(id),
    apply: (application) => study.applyAssessment(application),
  },
  tasks,
  runtime,
);
const token = 'f'.repeat(64);
const app = buildApp({ mini: { store: study, token, assessment } });
const act = (action) =>
  study.command({ requestId: randomUUID(), expectedRevision: study.snapshot().revision, action });
const day = () => {
  const value = study.snapshot().ledger.days.at(-1);
  assert.ok(value);
  return value;
};
try {
  const status = await runtime.status();
  assert.ok(status.available && status.authenticated, status.error ?? 'Codex login required');
  assert.ok(
    status.models
      .find((model) => model.id === 'gpt-6.1-sol')
      ?.supportedReasoningEfforts?.includes('xhigh'),
    'The exact selected model and xhigh effort must be available; no fallback',
  );
  study.importLegacy({
    requestId: randomUUID(),
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
    timezone,
  });
  act({
    type: 'set_long_term_plan',
    target: 'daily',
    plan: {
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      wordLimit: 10,
      newWordLimit: 5,

      dailyNewGoal: 2,
      groupSize: 2,
    },
  });
  const words = [
    { spelling: 'apple', meaning: '苹果', phonetic: '' },
    { spelling: 'bag', meaning: '包', phonetic: '' },
  ];
  act({ type: 'begin', target: 'daily', deck: words, timezone, flowVersion: 'sliding-window-v2' });
  const target = { target: 'daily', dayId: day().id };
  act({
    ...target,
    type: 'add_sentences',
    sentences: miniPreparationWords(day()).map((word) => ({
      word,
      english:
        word.spelling === 'apple' ? 'I eat an apple every morning.' : 'My bag is on the chair.',
      chinese: word.spelling === 'apple' ? '我每天早上吃一个苹果。' : '我的包在椅子上。',
    })),
  });
  for (let index = 0; index < 50; index++) {
    const visit = currentMiniWindow(day())?.visit;
    if (!visit) break;
    const ctx = { ...target, session: 'learning', word: visit.word, visitId: visit.id };
    if (visit.stage > 0) act({ ...ctx, type: 'window_choose', remembered: true });
    act({ ...ctx, type: 'window_advance', ...(visit.stage === 0 ? { remembered: true } : {}) });
  }
  let misspellingRecorded = false;
  for (let index = 0; index < 12 && day().learning?.phase === 'spelling'; index++) {
    const word = day().learning.queue[0];
    assert.ok(word);
    if (word.spelling === 'bag' && !misspellingRecorded) {
      act({
        ...target,
        session: 'learning',
        type: 'submit_spelling',
        word,
        answer: 'bga',
        advanceOnCorrect: false,
      });
      misspellingRecorded = true;
    }
    act({
      ...target,
      session: 'learning',
      type: 'submit_spelling',
      word,
      answer: word.spelling,
      advanceOnCorrect: false,
    });
    act({ ...target, session: 'learning', type: 'advance_spelling', word });
  }
  assert.equal(day().learning?.phase, 'finished');
  act({
    ...target,
    type: 'publish_writing',
    prompts: miniWritingWords(day()).map((word, index) => ({
      id: randomUUID(),
      sentence: {
        word,
        english:
          word.spelling === 'apple'
            ? "Thanks, Dad! I'll bring the apple tonight."
            : 'My bag is blue.',
        chinese:
          word.spelling === 'apple' ? '谢谢，爸爸！我今晚会把苹果带来。' : '我的包是蓝色的。',
      },
      direction: day().directions[index],
      focusIds: [],
    })),
  });
  act({ ...target, type: 'complete_learning' });
  for (let index = 0; index < 2; index++) {
    const task = currentTranslation(day());
    assert.ok(task);
    const answer =
      task.direction === 'englishToChinese' ? '谢啦爸，今晚我把苹果带过来' : 'My bga is blue.';
    act({ ...target, type: 'submit_translation', taskId: task.id, answer });
    act({ ...target, type: 'advance_translation', taskId: task.id });
  }
  assert.equal(day().flow.completed.length, 2);
  assert.equal(study.pendingAssessments().length, 2);
  const original = structuredClone(day().translation);
  const sources = structuredClone(study.snapshot().assessmentSources);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  assessment.setBaseUrl(address);
  console.log(
    'Live assessment: queued two already completed isolated answers; translation is free to continue.',
  );
  const deadline = Date.now() + 780_000;
  let previous = '';
  while (Date.now() < deadline) {
    const snapshot = assessment.snapshot();
    const progress = `${snapshot.pendingCount} queued, ${snapshot.runningCount} running, ${snapshot.failedCount} failed`;
    if (progress !== previous) {
      console.log(`Live assessment: ${progress}`);
      previous = progress;
    }
    if (snapshot.pendingCount === 0 && snapshot.runningCount === 0) break;
    await delay(500);
  }
  const final = assessment.snapshot();
  // The fixture contains only the two synthetic answers above. Preserve readable
  // evaluation/adoption diagnostics in the test log before temporary DB cleanup.
  const diagnostics = final.jobs.map((job) => {
    const detail = assessment.detail(job.id);
    return {
      word: detail.source.word.spelling,
      status: job.status,
      error: job.error,
      eligibility: detail.source.learningEvidence.eligibility,
      meaning: detail.application?.result.meaning,
      spelling: detail.application?.result.spelling,
      usage: detail.application?.result.usage,
      uncertainties: detail.application?.result.uncertainties,
      receipt: job.receipt,
    };
  });
  console.log(JSON.stringify({ isolatedAssessmentDiagnostics: diagnostics }, null, 2));
  assert.equal(final.pendingCount + final.runningCount, 0, 'Live assessment timed out');
  assert.equal(
    final.failedCount,
    0,
    final.jobs.find((job) => job.error)?.error ?? 'Assessment failed',
  );
  assert.equal(final.jobs.filter((job) => job.status === 'completed').length, 2);
  assert.deepEqual(
    day().translation,
    original,
    'Model assessment cannot replace original answers or confirm them again',
  );
  assert.deepEqual(study.snapshot().assessmentSources, sources);
  assert.equal(study.pendingAssessments().length, 0);
  const spelling = final.jobs
    .map((job) => assessment.detail(job.id))
    .find((detail) => detail.source.question.direction === 'chineseToEnglish');
  assert.ok(spelling, 'The live sample must include an actual English production answer');
  assert.equal(
    spelling.application.result.spelling.outcome,
    'incorrect',
    'The original bga spelling must remain an observed error',
  );
  const saved = study.snapshot(),
    details = final.jobs.map((job) => assessment.detail(job.id));
  const comprehension = details.find(
    (detail) => detail.source.question.direction === 'englishToChinese',
  );
  assert.equal(comprehension?.application?.result.expressionGrade, 'natural');
  assert.deepEqual(comprehension.application.result.improvements, []);
  assert.ok(
    ['adopted', 'partially_adopted'].includes(spelling.job.receipt.disposition),
    'A definite target-spelling error must have an adopted or partially adopted receipt',
  );
  assert.equal(
    saved.scheduling.flow.events.find(
      (event) => event.kind === 'assessment' && event.sourceId === spelling.source.id,
    )?.reviewCeilingDays,
    1,
    'The clear target-spelling error must produce its conservative follow-up bound',
  );
  for (const detail of details) {
    assert.equal(detail.application.trace.model, 'gpt-6.1-sol');
    assert.equal(detail.application.trace.effort, 'xhigh');
    study.applyAssessment(detail.application);
  }
  assert.deepEqual(study.snapshot(), saved, 'Adoption retries must not duplicate schedule events');
  await app.close();
  const reopenedStudy = new MiniStore(studyFile),
    reopenedTasks = new MiniAssessmentStore(taskFile);
  try {
    assert.deepEqual(reopenedStudy.snapshot(), saved);
    for (const detail of details) assert.deepEqual(reopenedTasks.detail(detail.job.id), detail);
  } finally {
    reopenedStudy.close();
    reopenedTasks.close();
  }
  console.log(
    JSON.stringify(
      {
        completed: 2,
        model: 'gpt-6.1-sol',
        effort: 'xhigh',
        audit: details.map((detail) => ({
          word: detail.source.word.spelling,
          meaning: detail.application.result.meaning.outcome,
          spelling: detail.application.result.spelling.outcome,
          disposition: detail.job.receipt.disposition,
          rulesVersion: detail.application.trace.rulesVersion,
        })),
        originalAnswersPreserved: true,
        sqliteReopenExact: true,
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
