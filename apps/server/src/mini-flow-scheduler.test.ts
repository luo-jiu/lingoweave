import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  miniSnapshotSchema,
  type MiniAssessmentApplication,
  type MiniFlowScheduleEvent,
  type MiniWord,
} from '@lingoweave/contracts';
import {
  applyFlowAssessment,
  flowMemory,
  nextFlowDay,
  recordFlowSchedule,
  validateMiniFlowScheduling,
} from './mini-flow-scheduler.js';
import { localDay, swiftTime } from './mini-study.js';

const word: MiniWord = { spelling: 'bag', meaning: '包', phonetic: '' };
const at = swiftTime(new Date('2026-11-17T02:00:00Z'));
const timezone = 'Asia/Shanghai';
const date = (value: number) => new Date((value + 978307200) * 1000);
function state() {
  return miniSnapshotSchema.parse({
    schemaVersion: 1,
    revision: 0,
    imported: true,
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
  });
}
function event(
  overrides: Partial<Omit<MiniFlowScheduleEvent, 'load'>> = {},
): Omit<MiniFlowScheduleEvent, 'load'> {
  return {
    id: randomUUID(),
    word,
    kind: 'completion',
    sourceId: 'answer',
    occurredAt: at,
    recordedAt: at,
    timezone,
    meaning: null,
    spelling: null,
    evidence: 'learning',
    nextDay: true,
    reasons: ['test fact'],
    ...overrides,
  };
}
function assessment(eligible = true): MiniAssessmentApplication {
  const id = randomUUID();
  const source: MiniAssessmentApplication['source'] = {
    schemaVersion: 1,
    id,
    attemptId: 'answer',
    dayId: 'day',
    word,
    timezone,
    question: {
      id: 'question',
      direction: 'chineseToEnglish',
      english: 'My bag is blue.',
      chinese: '我的包是蓝色的。',
    },
    answer: 'My bag is blue.',
    submittedAt: at - 1,
    confirmedAt: at,
    learningEvidence: { eligibility: { meaning: eligible, spelling: eligible } },
    discussion: [],
  };
  const inputHash = createHash('sha256').update(JSON.stringify(source)).digest('hex');
  const observation = {
    outcome: 'correct' as const,
    explanation: 'Target used correctly.',
    evidenceIds: [id],
  };
  return {
    requestId: randomUUID(),
    source,
    result: {
      sourceId: id,
      inputHash,
      meaning: observation,
      spelling: observation,
      usage: observation,
      summary: 'Correct.',
      strengths: [],
      improvements: [],
      referenceTranslation: 'My bag is blue.',
      uncertainties: [],
    },
    trace: {
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
      threadId: null,
      rulesVersion: 'mini-assessment-v1',
      skillHash: 'a'.repeat(64),
      promptHash: 'b'.repeat(64),
      inputHash,
      startedAt: at,
      assessedAt: at + 20,
    },
  };
}
test('next day follows the local calendar across both DST transitions and unusual offsets', () => {
  for (const [start, zone, expected] of [
    ['2026-03-08T05:30:00Z', 'America/New_York', '2026-03-09T04:00:00Z'],
    ['2026-11-01T04:30:00Z', 'America/New_York', '2026-11-02T05:00:00Z'],
    ['2026-11-17T14:10:00Z', 'Australia/Adelaide', '2026-11-18T13:30:00Z'],
    ['2026-11-17T02:00:00Z', timezone, '2026-11-17T16:00:00Z'],
  ]) {
    assert.ok(start && zone && expected);
    assert.equal(
      date(nextFlowDay(swiftTime(new Date(start)), zone)).toISOString(),
      new Date(expected).toISOString(),
    );
  }
});
test('new completion schedules tomorrow while assessment is missing; positive assessment cannot remove first review', () => {
  const snapshot = state();
  recordFlowSchedule(snapshot, event());
  const due = nextFlowDay(at, timezone);
  assert.equal(flowMemory(snapshot, word)?.dueAt, due);
  assert.equal(flowMemory(snapshot, word)?.meaning, null);
  applyFlowAssessment(snapshot, assessment(), at + 60);
  assert.equal(flowMemory(snapshot, word)?.dueAt, due);
  assert.equal(flowMemory(snapshot, word)?.meaning?.reps, 1);
  validateMiniFlowScheduling(miniSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot))));
});
test('supported and uncertain translations do not create independent successful repetitions', () => {
  const snapshot = state();
  recordFlowSchedule(snapshot, event());
  applyFlowAssessment(snapshot, assessment(false), at + 60);
  assert.equal(flowMemory(snapshot, word)?.meaning, null);
  assert.equal(flowMemory(snapshot, word)?.spelling, null);
  const uncertain = assessment();
  uncertain.result.uncertainties = ['The target may not have been tested.'];
  const receipt = applyFlowAssessment(snapshot, uncertain, at + 120);
  assert.equal(receipt.disposition, 'pending_review');
  assert.equal(flowMemory(snapshot, word)?.meaning, null);
  assert.equal(flowMemory(snapshot, word)?.dueAt, nextFlowDay(at, timezone));
});
test('a late assessment replays before the actual later review and survives normalized JSON reopening', () => {
  const early = state(),
    late = state();
  const completed = event();
  const application = assessment();
  const review = event({
    id: 'later-review',
    kind: 'review',
    sourceId: 'review-day',
    occurredAt: at + 86400,
    recordedAt: at + 86500,
    meaning: 'Good',
    spelling: null,
    evidence: 'self_report',
    nextDay: false,
  });
  for (const snapshot of [early, late]) recordFlowSchedule(snapshot, completed);
  applyFlowAssessment(early, application, at + 20);
  recordFlowSchedule(early, review);
  recordFlowSchedule(late, review);
  applyFlowAssessment(late, application, at + 2 * 86400);
  assert.deepEqual(flowMemory(late, word), flowMemory(early, word));
  assert.equal(flowMemory(late, word)?.lastEventId, review.id);
  assert.equal(flowMemory(late, word)?.meaning?.reps, 2);
  assert.equal(
    late.scheduling.flow.events.find((item) => item.id === review.id)?.occurredAt,
    review.occurredAt,
  );
  validateMiniFlowScheduling(miniSnapshotSchema.parse(JSON.parse(JSON.stringify(late))));
});
test('unchanged duplicate events do not add a repetition and changed facts with the same id are rejected', () => {
  const snapshot = state();
  const original = event({ kind: 'review', meaning: 'Good', nextDay: false });
  recordFlowSchedule(snapshot, original);
  const parsed = miniSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)));
  recordFlowSchedule(parsed, original);
  assert.equal(parsed.scheduling.flow.events.length, 1);
  assert.equal(flowMemory(parsed, word)?.meaning?.reps, 1);
  assert.throws(() => recordFlowSchedule(parsed, { ...original, meaning: 'Again' }), /不能被覆盖/);
});
test('repeated real recall at increasing intervals grows the interval, without stale unmeasured spelling locking it to daily', () => {
  const snapshot = state();
  recordFlowSchedule(snapshot, event({ spelling: 'Good', nextDay: true, evidence: 'model' }));
  let reviewedAt = at + 86400;
  let priorInterval = 0;
  for (let i = 0; i < 4; i++) {
    recordFlowSchedule(
      snapshot,
      event({
        kind: 'review',
        occurredAt: reviewedAt,
        recordedAt: reviewedAt,
        meaning: 'Good',
        nextDay: false,
        evidence: 'self_report',
      }),
    );
    const card = flowMemory(snapshot, word);
    assert.ok(card);
    const interval = card.dueAt - reviewedAt;
    assert.ok(interval > priorInterval, `${interval} should exceed ${priorInterval}`);
    priorInterval = interval;
    reviewedAt = card.dueAt + 3600;
  }
  assert.equal(flowMemory(snapshot, word)?.spelling?.reps, 1);
});
test('longer review intervals balance within three calendar days and preserve the ideal date', () => {
  const snapshot = state();
  const dueDates = new Set<string>();
  for (let i = 0; i < 30; i++) {
    const target = { ...word, spelling: `target${i}` };
    recordFlowSchedule(
      snapshot,
      event({
        word: target,
        kind: 'review',
        meaning: 'Good',
        nextDay: false,
        evidence: 'self_report',
      }),
    );
    recordFlowSchedule(
      snapshot,
      event({
        word: target,
        kind: 'review',
        occurredAt: at + 7 * 86400,
        recordedAt: at + 7 * 86400,
        meaning: 'Good',
        nextDay: false,
        evidence: 'self_report',
      }),
    );
    const card = flowMemory(snapshot, target);
    assert.ok(card);
    const dueDate = localDay(date(card.dueAt), timezone);
    const idealDate = localDay(date(card.idealDueAt), timezone);
    assert.ok(Math.abs(Date.parse(dueDate) - Date.parse(idealDate)) <= 3 * 86400000);
    dueDates.add(dueDate);
  }
  assert.ok(dueDates.size > 1);
  validateMiniFlowScheduling(miniSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot))));
});

test('a same-day independent probe cannot displace the mandatory next-day first review', () => {
  const snapshot = state();
  recordFlowSchedule(snapshot, event());
  recordFlowSchedule(
    snapshot,
    event({
      kind: 'probe',
      occurredAt: at + 3600,
      recordedAt: at + 3600,
      spelling: 'Good',
      evidence: 'objective',
      nextDay: false,
    }),
  );
  assert.equal(flowMemory(snapshot, word)?.dueAt, nextFlowDay(at, timezone));
});
test('learning difficulties cap only the first review interval and never fabricate FSRS failures', () => {
  const strong = state(),
    difficult = state();
  recordFlowSchedule(strong, event());
  recordFlowSchedule(difficult, event({ reviewCeilingDays: 1 }));
  assert.equal(flowMemory(difficult, word)?.meaning, null);
  assert.equal(flowMemory(difficult, word)?.dueAt, flowMemory(strong, word)?.dueAt);
  const firstReviewAt = at + 86400;
  const first = event({
    kind: 'review',
    sourceId: 'first-review',
    occurredAt: firstReviewAt,
    recordedAt: firstReviewAt,
    meaning: 'Good',
    evidence: 'self_report',
    nextDay: false,
  });
  for (const snapshot of [strong, difficult]) recordFlowSchedule(snapshot, first);
  assert.equal(flowMemory(difficult, word)?.dueAt, nextFlowDay(firstReviewAt, timezone));
  assert.ok((flowMemory(strong, word)?.dueAt ?? 0) > (flowMemory(difficult, word)?.dueAt ?? 0));
  assert.equal(flowMemory(difficult, word)?.meaning?.lapses, 0);
  const secondAt = at + 2 * 86400;
  recordFlowSchedule(
    difficult,
    event({
      kind: 'review',
      sourceId: 'second-review',
      occurredAt: secondAt,
      recordedAt: secondAt,
      meaning: 'Good',
      evidence: 'self_report',
      nextDay: false,
    }),
  );
  assert.ok((flowMemory(difficult, word)?.dueAt ?? 0) > nextFlowDay(secondAt, timezone));
});
test('a target spelling error has a bounded first-review effect even when translation was supported', () => {
  const snapshot = state();
  recordFlowSchedule(snapshot, event());
  const application = assessment(false);
  application.result.spelling = {
    outcome: 'incorrect',
    explanation: 'Target spelling transposed.',
    evidenceIds: [application.source.id],
  };
  const receipt = applyFlowAssessment(snapshot, application, at + 300);
  assert.equal(receipt.disposition, 'adopted');
  const adopted = snapshot.scheduling.flow.events.find((item) => item.kind === 'assessment');
  assert.equal(adopted?.spelling, null);
  assert.equal(adopted?.reviewCeilingDays, 1);
  assert.equal(flowMemory(snapshot, word)?.spelling, null);
});

test('a later severe review creates a fresh bounded ceiling instead of being cleared by an older review id', () => {
  const snapshot = state();
  recordFlowSchedule(snapshot, event());
  for (const [index, days] of [1, 4].entries()) {
    recordFlowSchedule(
      snapshot,
      event({
        kind: 'review',
        sourceId: `review-${index}`,
        occurredAt: at + days * 86400,
        recordedAt: at + days * 86400,
        meaning: 'Good',
        evidence: 'self_report',
        nextDay: false,
      }),
    );
  }
  const failedAt = at + 14 * 86400;
  recordFlowSchedule(
    snapshot,
    event({
      kind: 'review',
      sourceId: 'review-2',
      occurredAt: failedAt,
      recordedAt: failedAt,
      meaning: 'Good',
      evidence: 'self_report',
      nextDay: false,
    }),
  );
  recordFlowSchedule(
    snapshot,
    event({
      kind: 'review',
      sourceId: 'review-2',
      occurredAt: failedAt + 60,
      recordedAt: failedAt + 60,
      reviewCeilingDays: 1,
      evidence: 'learning',
      nextDay: true,
    }),
  );
  const nextAt = at + 15 * 86400;
  recordFlowSchedule(
    snapshot,
    event({
      kind: 'review',
      sourceId: 'review-3',
      occurredAt: nextAt,
      recordedAt: nextAt,
      meaning: 'Good',
      evidence: 'self_report',
      nextDay: false,
    }),
  );
  assert.equal(flowMemory(snapshot, word)?.dueAt, nextFlowDay(nextAt, timezone));
  const following = at + 16 * 86400;
  recordFlowSchedule(
    snapshot,
    event({
      kind: 'review',
      sourceId: 'review-4',
      occurredAt: following,
      recordedAt: following,
      meaning: 'Good',
      evidence: 'self_report',
      nextDay: false,
    }),
  );
  assert.ok((flowMemory(snapshot, word)?.dueAt ?? 0) > nextFlowDay(following, timezone));
});
