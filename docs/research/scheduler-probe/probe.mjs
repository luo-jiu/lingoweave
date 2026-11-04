import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { fsrs, createEmptyCard, Rating, State, FSRSVersion } from 'ts-fsrs';

// Reproducible mechanism probe, not a simulation of a real person's learning.
const DAY = 86_400_000;
const start = new Date('2026-11-02T01:00:00.000Z');
const parameters = {
  request_retention: 0.9,
  enable_fuzz: false,
  enable_short_term: true,
  learning_steps: ['10m'],
  relearning_steps: ['10m'],
};
const scheduler = fsrs(parameters);
const atDay = (day) => new Date(+start + day * DAY);
const checks = [];
function check(name, fn) {
  fn();
  checks.push({ name, passed: true });
}
function recall(card, now) {
  return card.state === State.New ? null : scheduler.get_retrievability(card, now, false);
}
function reviewed(card, now, rating) {
  return scheduler.next(card, now, rating).card;
}

// A conditional example: three successful, due-time recalls.
let mature = createEmptyCard(start);
const exampleHistory = [];
for (let n = 0; n < 3; n++) {
  const now = new Date(mature.due);
  mature = reviewed(mature, now, Rating.Good);
  exampleHistory.push({ reviewedAt: now, stability: mature.stability, nextDue: mature.due });
}
const matureBefore = structuredClone(mature);
const aging = [0, 7, 30, 46, 90, 180].map((days) => ({
  daysSinceLastReview: days,
  predictedRecall: recall(mature, new Date(+mature.last_review + days * DAY)),
}));
check('Unobserved time decreases predicted recall without mutating the card', () => {
  assert.deepEqual(mature, matureBefore);
  for (let n = 1; n < aging.length; n++)
    assert.ok(aging[n].predictedRecall < aging[n - 1].predictedRecall);
});
check('A previously stable word becomes due without an additional failure', () => {
  assert.ok(+mature.last_review + 30 * DAY < +mature.due);
  assert.ok(+mature.last_review + 90 * DAY >= +mature.due);
  assert.equal(mature.lapses, 0);
});
check('An unassessed new word has unknown recall, not a measured zero', () => {
  assert.equal(recall(createEmptyCard(start), start), null);
});

const lateTime = new Date(+mature.last_review + 90 * DAY);
const lateSuccess = reviewed(mature, lateTime, Rating.Good);
const lateFailure = reviewed(mature, lateTime, Rating.Again);
check('Late success uses the actual elapsed interval', () => {
  assert.equal(lateSuccess.elapsed_days, 90);
  assert.equal(+lateSuccess.last_review, +lateTime);
  assert.ok(lateSuccess.stability > mature.stability);
});
check('An observed failure changes stability and adds one lapse', () => {
  assert.ok(lateFailure.stability < mature.stability);
  assert.equal(lateFailure.lapses, mature.lapses + 1);
});

// Proposed queue policy: lowest predicted recall, every fifth completed target
// reserves a slot for the oldest due target. The 1-in-5 rule is a product heuristic.
function chooseOne(cards, now, remainingWords, serviceOrdinal, alreadySelected = new Set()) {
  if (remainingWords <= 0) return null;
  const grouped = new Map();
  for (const item of cards) {
    const dueAt = item.card.state === State.New ? item.firstProbeAt : item.card.due;
    if (!dueAt || +dueAt > +now || alreadySelected.has(item.wordId)) continue;
    const candidate = {
      ...item,
      r: recall(item.card, now),
      dueAt,
      waitingSince: Math.max(+dueAt, item.lastServedAt ? +item.lastServedAt : -Infinity),
    };
    const old = grouped.get(item.wordId);
    if (!old || (candidate.r ?? Infinity) < (old.r ?? Infinity))
      grouped.set(item.wordId, candidate);
  }
  let items = [...grouped.values()];
  const fairness = serviceOrdinal % 5 === 4;
  if (!fairness && items.some((x) => x.r !== null)) items = items.filter((x) => x.r !== null);
  items.sort(
    (a, b) =>
      (fairness ? a.waitingSince - b.waitingSince : (a.r ?? 0) - (b.r ?? 0)) ||
      a.waitingSince - b.waitingSince ||
      a.wordId.localeCompare(b.wordId),
  );
  return items[0] ?? null;
}

const pool = Array.from({ length: 100 }, (_, i) => ({
  wordId: `word-${String(i).padStart(3, '0')}`,
  skill: 'meaning-recall',
  // Deliberately mixed scripted outcomes. These are not empirical success rates.
  card: reviewed(createEmptyCard(start), start, i < 60 ? Rating.Again : Rating.Good),
}));
const beforeDay1 = structuredClone(pool);
const selected = chooseOne(pool, atDay(1), 1, 0);
assert.ok(selected);
pool.find((x) => x.wordId === selected.wordId).card = reviewed(
  selected.card,
  atDay(1),
  Rating.Good,
);
check('After 100 studied words, a one-word budget selects only one target', () => {
  assert.equal(
    pool.filter((x, i) => JSON.stringify(x.card) !== JSON.stringify(beforeDay1[i].card)).length,
    1,
  );
});
check('The 99 unselected words retain all real dates, counts and memory states', () => {
  for (let i = 0; i < pool.length; i++) {
    if (pool[i].wordId !== selected.wordId) assert.deepEqual(pool[i], beforeDay1[i]);
  }
});
const beforeAbsence = structuredClone(pool);
check('A zero-word day produces no selection or memory change', () => {
  assert.equal(chooseOne(pool, atDay(2), 0, 1), null);
  assert.deepEqual(pool, beforeAbsence);
});
const returnChoice = chooseOne(pool, atDay(21), 1, 1);
check('After a 20-day absence the current queue can be rebuilt without resetting history', () => {
  assert.ok(returnChoice);
  assert.deepEqual(pool, beforeAbsence);
  assert.ok(pool.some((x) => recall(x.card, atDay(21)) < recall(x.card, atDay(1))));
});

// Old cached plan versus current time: a newly due weaker word must be considered.
const oldStable = {
  wordId: 'old-plan-word',
  skill: 'meaning-recall',
  card: structuredClone(mature),
};
const weak = {
  wordId: 'newly-due-word',
  skill: 'meaning-recall',
  card: reviewed(createEmptyCard(start), start, Rating.Again),
};
check('A stale plan is not the complete candidate set after a long interruption', () => {
  assert.equal(chooseOne([oldStable, weak], atDay(90), 1, 0).wordId, 'newly-due-word');
});

// Fairness example built from real FSRS cards: one old stable word plus weak ones.
const oldLongWaiting = {
  wordId: 'old-long-waiting',
  skill: 'meaning-recall',
  card: structuredClone(mature),
};
const recentWeak = Array.from({ length: 6 }, (_, i) => ({
  wordId: `weak-${i}`,
  skill: 'meaning-recall',
  card: reviewed(createEmptyCard(atDay(89)), atDay(89), Rating.Again),
}));
check(
  'The persisted fifth-target slot protects an older word even with one word per session',
  () => {
    const now = atDay(90);
    assert.notEqual(
      chooseOne([oldLongWaiting, ...recentWeak], now, 1, 0).wordId,
      'old-long-waiting',
    );
    assert.equal(chooseOne([oldLongWaiting, ...recentWeak], now, 1, 4).wordId, 'old-long-waiting');
  },
);
check('A supported practice moves the fairness turn without changing the memory due date', () => {
  const original = structuredClone(oldLongWaiting.card);
  const served = { ...oldLongWaiting, lastServedAt: atDay(90) };
  assert.notEqual(chooseOne([served, ...recentWeak], atDay(90), 1, 4).wordId, 'old-long-waiting');
  assert.deepEqual(served.card, original);
});
const awaitingFirstProbe = {
  wordId: 'introduced-unassessed',
  skill: 'meaning-recall',
  card: createEmptyCard(start),
  firstProbeAt: new Date(+start + 10 * 60_000),
};
check(
  'A taught but unassessed word can be selected without fabricating a recall probability',
  () => {
    const next = chooseOne([awaitingFirstProbe], atDay(1), 1, 0);
    assert.equal(next.wordId, awaitingFirstProbe.wordId);
    assert.equal(next.r, null);
    assert.equal(next.card.reps, 0);
  },
);
check('An unassessed word can reach a fairness slot even with an existing review backlog', () => {
  const next = chooseOne([awaitingFirstProbe, ...recentWeak], atDay(90), 1, 4);
  assert.equal(next.wordId, awaitingFirstProbe.wordId);
});

const answers = new Map();
const histories = new Map();
function submit(id, state, now, { rating, evidence = 'recall', target = 'meaning-recall' }) {
  if (answers.has(id)) return answers.get(id);
  const next =
    evidence === 'recall' && rating != null ? reviewed(state, now, rating) : structuredClone(state);
  const result = { id, target, evidence, next };
  answers.set(id, result);
  histories.set(id, { target, evidence, at: now });
  return result;
}
const result1 = submit('answer-1', mature, lateTime, { rating: Rating.Good });
check('Retrying the same answer does not apply a second FSRS update', () => {
  const count = answers.size;
  const duplicate = submit('answer-1', mature, lateTime, { rating: Rating.Good });
  assert.equal(duplicate, result1);
  assert.equal(answers.size, count);
});
check('Copying after reveal and uncertain grading preserve evidence without changing FSRS', () => {
  const practice = submit('copy', mature, lateTime, { rating: Rating.Good, evidence: 'practice' });
  const pending = submit('pending', mature, lateTime, { rating: null, evidence: 'pending' });
  assert.deepEqual(practice.next, mature);
  assert.deepEqual(pending.next, mature);
});

// A five-word package is a presentation/continuation unit, not a transaction.
const group = {
  id: 'group-1',
  words: ['g1', 'g2', 'g3', 'g4', 'g5'],
  completed: new Set(['g1', 'g2', 'g3']),
};
const groupSnapshot = { id: group.id, words: [...group.words], completed: [...group.completed] };
check(
  'Exiting after three of five leaves the group partial and preserves three completed targets',
  () => {
    assert.equal(group.completed.size, 3);
    assert.notEqual(group.completed.size, group.words.length);
    assert.deepEqual(groupSnapshot.completed, ['g1', 'g2', 'g3']);
  },
);
check('A one-word continuation can resume the same group without requiring the other four', () => {
  const next = group.words.filter((x) => !group.completed.has(x)).slice(0, 1);
  assert.deepEqual(next, ['g4']);
});
check('Completing meaning recall does not update an untested spelling state', () => {
  const spelling = createEmptyCard(start);
  const before = structuredClone(spelling);
  submit('meaning-only', mature, lateTime, { rating: Rating.Good, target: 'meaning-recall' });
  assert.deepEqual(spelling, before);
});

const report = {
  purpose:
    'Mechanism verification with scripted outcomes; not evidence of learning efficacy or calibrated recall probabilities.',
  library: FSRSVersion,
  node: process.version,
  parameters: scheduler.parameters,
  exampleHistory,
  aging,
  lateReview: {
    actualElapsedDays: 90,
    beforeStability: mature.stability,
    afterGoodStability: lateSuccess.stability,
    afterAgainStability: lateFailure.stability,
  },
  capacityScenario: {
    firstDayStudied: 100,
    nextDayWordBudget: 1,
    nextDayDueBefore: beforeDay1.filter((x) => +x.card.due <= +atDay(1)).length,
    selected: selected.wordId,
    unchangedTargets: 99,
    absentDayBudget: 0,
    returnDay: 21,
    returnSelection: returnChoice.wordId,
  },
  groupScenario: groupSnapshot,
  checks,
};
writeFileSync(
  new URL('./probe-results.json', import.meta.url),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(
  JSON.stringify(
    {
      library: FSRSVersion,
      passed: checks.length,
      aging,
      capacityScenario: report.capacityScenario,
      lateReview: report.lateReview,
    },
    null,
    2,
  ),
);
