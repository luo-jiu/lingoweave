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
  rebuildMiniFlowDueSchedules,
  recordFlowSchedule,
  validateMiniFlowScheduling,
} from './mini-flow-scheduler.js';
import { localDay, outstandingReviews, swiftTime } from './mini-study.js';

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

test('a supported spelling preserves the adjusted date assigned to the meaning review, including across a database upgrade', () => {
  const snapshot = state();
  let adjusted: MiniWord | undefined;
  for (let index = 0; index < 3; index++) {
    const target = { ...word, spelling: `balanced-${index}` };
    for (const [round, elapsed] of [0, 3].entries()) {
      const time = at + elapsed * 86400;
      recordFlowSchedule(
        snapshot,
        event({
          word: target,
          kind: 'review',
          sourceId: `group-${round}`,
          occurredAt: time,
          recordedAt: time,
          meaning: 'Good',
          nextDay: false,
        }),
      );
    }
    const judgment = flowMemory(snapshot, target);
    assert.ok(judgment);
    const time = at + 3 * 86400 + 30;
    recordFlowSchedule(
      snapshot,
      event({
        word: target,
        kind: 'review',
        sourceId: 'group-1',
        occurredAt: time,
        recordedAt: time,
        nextDay: false,
        meaning: null,
        spelling: null,
      }),
    );
    const combined = flowMemory(snapshot, target);
    assert.equal(combined?.dueAt, judgment.dueAt);
    assert.deepEqual(combined?.meaning, judgment.meaning);
    assert.equal(combined?.spelling, null);
    if (localDay(date(judgment.dueAt), timezone) !== localDay(date(judgment.idealDueAt), timezone))
      adjusted = target;
  }
  assert.ok(adjusted, 'a cohort must actually receive an off-ideal calendar day');
  const card = flowMemory(snapshot, adjusted);
  assert.ok(card);
  const original = structuredClone(card);
  const audit = snapshot.scheduling.flow.changes
    .filter((change) => change.after.senseId === card.senseId)
    .at(-1);
  assert.ok(audit);
  card.dueAt = card.idealDueAt;
  audit.after = structuredClone(card);
  assert.throws(() => validateMiniFlowScheduling(snapshot), /不一致/);
  validateMiniFlowScheduling(snapshot, undefined, { allowArchivedDueDates: true });
  const raw = structuredClone(snapshot.scheduling.flow.events);
  const oldAudit = structuredClone(snapshot.scheduling.flow.changes);
  const damaged = structuredClone(snapshot);
  const bad = flowMemory(damaged, adjusted);
  assert.ok(bad);
  bad.dueAt++;
  assert.throws(() => rebuildMiniFlowDueSchedules(damaged, at), /审计不一致/);
  assert.throws(
    () => validateMiniFlowScheduling(damaged, undefined, { allowArchivedDueDates: true }),
    /不一致/,
  );
  assert.equal(rebuildMiniFlowDueSchedules(snapshot, at + 50 * 86400), true);
  assert.deepEqual(flowMemory(snapshot, adjusted), original);
  assert.deepEqual(snapshot.scheduling.flow.events, raw);
  assert.deepEqual(snapshot.scheduling.flow.changes.slice(0, -1), oldAudit);
  validateMiniFlowScheduling(snapshot);
  assert.equal(rebuildMiniFlowDueSchedules(snapshot, at + 51 * 86400), false);
});

test('next-day failure, overdue review and first-review ceiling survive an independent spelling probe', () => {
  const snapshot = state();
  const put = (kind: 'review' | 'probe', time: number, values: Partial<MiniFlowScheduleEvent>) =>
    recordFlowSchedule(
      snapshot,
      event({
        kind,
        occurredAt: time,
        recordedAt: time,
        sourceId: randomUUID(),
        nextDay: false,
        ...values,
      }),
    );
  put('review', at, { meaning: 'Good', nextDay: true, reviewCeilingDays: 2 });
  const tomorrow = nextFlowDay(at, timezone);
  put('probe', at + 300, { spelling: 'Good' });
  assert.equal(flowMemory(snapshot, word)?.dueAt, tomorrow);
  put('probe', tomorrow + 5 * 86400, { spelling: 'Good' });
  assert.equal(flowMemory(snapshot, word)?.dueAt, tomorrow);
  const first = tomorrow + 6 * 86400 + 3600;
  put('review', first, { meaning: 'Good' });
  const capped = flowMemory(snapshot, word)?.dueAt;
  assert.equal(capped, nextFlowDay(nextFlowDay(first, timezone), timezone));
  put('probe', first + 86400, { spelling: 'Good' });
  assert.equal(
    flowMemory(snapshot, word)?.dueAt,
    capped,
    'cap anchored to the review, not the later probe',
  );
  put('review', capped + 60, { meaning: 'Good' });
  const mature = flowMemory(snapshot, word);
  assert.ok(mature && mature.dueAt > capped + 2 * 86400);
  put('probe', mature.dueAt + 86400, { spelling: 'Good' });
  assert.equal(
    flowMemory(snapshot, word)?.dueAt,
    mature.dueAt,
    'overdue meaning remains in the combined queue',
  );
});

test('after a three-round failure, a later milder difficulty gets its own ceiling', () => {
  const snapshot = state();
  const group = (sourceId: string, time: number, failure?: 1 | 2) => {
    recordFlowSchedule(
      snapshot,
      event({
        kind: 'review',
        sourceId,
        occurredAt: time,
        recordedAt: time,
        meaning: 'Good',
        nextDay: false,
      }),
    );
    if (failure)
      recordFlowSchedule(
        snapshot,
        event({
          kind: 'review',
          sourceId,
          occurredAt: time + 30,
          recordedAt: time + 30,
          nextDay: true,
          reviewCeilingDays: failure,
        }),
      );
  };
  group('severe', at, 1);
  group('milder', at + 86400, 2);
  const recovered = at + 2 * 86400;
  group('recovered', recovered);
  assert.equal(
    flowMemory(snapshot, word)?.dueAt,
    nextFlowDay(nextFlowDay(recovered, timezone), timezone),
  );
});

test('equal load keeps the model’s local calendar date for an evening review across both DST transitions', () => {
  const zone = 'America/New_York';
  for (const start of ['2026-03-05T03:00:00Z', '2026-10-29T02:00:00Z']) {
    const snapshot = state();
    const time = swiftTime(new Date(start));
    for (const elapsed of [0, 2]) {
      recordFlowSchedule(
        snapshot,
        event({
          timezone: zone,
          kind: 'review',
          sourceId: `review-${elapsed}`,
          occurredAt: time + elapsed * 86400,
          recordedAt: time + elapsed * 86400,
          meaning: 'Good',
          nextDay: false,
        }),
      );
    }
    const card = flowMemory(snapshot, word);
    assert.ok(card?.meaning && card.meaning.scheduled_days >= 3);
    assert.equal(localDay(date(card.dueAt), zone), localDay(date(card.idealDueAt), zone));
    assert.equal(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        hour: '2-digit',
        minute: '2-digit',
      }).format(date(card.dueAt)),
      '00:00',
    );
  }
});

test('short-interval balancing uses the three local days boundary across DST', () => {
  const zone = 'America/New_York';
  const put = (snapshot: ReturnType<typeof state>, time: string, meaning: 'Hard' | 'Good') => {
    const when = swiftTime(new Date(time));
    recordFlowSchedule(
      snapshot,
      event({
        kind: 'review',
        sourceId: time,
        timezone: zone,
        occurredAt: when,
        recordedAt: when,
        meaning,
        nextDay: false,
      }),
    );
    const card = flowMemory(snapshot, word);
    assert.ok(card);
    return card;
  };
  const fall = state();
  put(fall, '2026-10-30T04:15:00Z', 'Hard');
  const short = put(fall, '2026-10-31T04:15:00Z', 'Hard');
  // 72 hours, but October 31 at 00:15 to November 2 at 23:15 is only two calendar days.
  assert.equal(short.meaning?.scheduled_days, 3);
  assert.equal(localDay(date(short.idealDueAt), zone), '2026-11-02');
  assert.equal(date(short.dueAt).toISOString(), '2026-11-02T05:00:00.000Z');
  assert.equal(short.idealDueAt, short.meaning.due);
  const spring = state();
  const eligible = put(spring, '2026-03-08T04:15:00Z', 'Good');
  // 48 hours from Saturday March 7 at 23:15 now reaches Tuesday March 10 at 00:15.
  assert.equal(eligible.meaning?.scheduled_days, 2);
  assert.equal(localDay(date(eligible.idealDueAt), zone), '2026-03-10');
  assert.equal(date(eligible.dueAt).toISOString(), '2026-03-10T04:00:00.000Z');
});

test('every due word opens at the start of the chosen local day, with the raw FSRS instant preserved in the model and migration audit', () => {
  for (const [zone, started, opens] of [
    ['Asia/Shanghai', '2026-11-19T08:15:00Z', '2026-11-20T16:00:00Z'],
    ['America/New_York', '2026-03-07T15:30:00Z', '2026-03-09T04:00:00Z'],
    // Chile moves straight from 23:59:59 to 01:00 on this date.
    ['America/Santiago', '2026-09-04T14:30:00Z', '2026-09-06T04:00:00Z'],
  ] as const) {
    const snapshot = state();
    const start = swiftTime(new Date(started));
    const midnight = swiftTime(new Date(opens));
    recordFlowSchedule(
      snapshot,
      event({
        kind: 'review',
        timezone: zone,
        sourceId: 'graded',
        occurredAt: start,
        recordedAt: start + 120,
        meaning: 'Good',
        spelling: 'Good',
        nextDay: false,
      }),
    );
    const card = flowMemory(snapshot, word);
    assert.ok(card?.meaning && card.spelling);
    assert.equal(card.dueAt, midnight);
    assert.equal(card.meaning.due, start + 2 * 86400);
    assert.equal(card.spelling.due, card.meaning.due);
    assert.equal(card.idealDueAt, card.meaning.due);
    for (const [clock, count] of [
      [midnight - 1, 0],
      [midnight, 1],
      [midnight + 8 * 3600, 1],
      [midnight + 20 * 3600, 1],
    ] as const)
      assert.equal(
        outstandingReviews(snapshot, clock, localDay(date(clock), zone), [word]).size,
        count,
      );

    const audit = snapshot.scheduling.flow.changes.at(-1);
    assert.ok(audit);
    card.dueAt = card.idealDueAt;
    audit.after = structuredClone(card);
    const old = structuredClone(card);
    assert.equal(rebuildMiniFlowDueSchedules(snapshot, midnight + 3600), true);
    const migrated = flowMemory(snapshot, word);
    assert.deepEqual(migrated, { ...old, dueAt: midnight });
    assert.deepEqual(snapshot.scheduling.flow.changes.at(-1)?.before, old);
    assert.equal(rebuildMiniFlowDueSchedules(snapshot, midnight + 7200), false);
  }
});
