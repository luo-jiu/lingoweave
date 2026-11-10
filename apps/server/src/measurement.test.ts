import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyMeasurement,
  defaultMeasurementRules,
  type MeasurementInput,
} from './measurement.js';

const time = (seconds: number) => new Date(Date.UTC(2026, 10, 3) + seconds * 1_000).toISOString();
const base: MeasurementInput = {
  eventId: 'attempt-1',
  targetId: 'en:apple:noun:fruit',
  ability: 'spelling',
  kind: 'attempt',
  occurredAt: time(60),
  answerProvided: true,
  outcome: 'correct',
  assessment: 'objective',
  help: 'none',
  lastAnswerExposureAt: null,
};

test('viewing and self-assessment provide no independent recall result', () => {
  for (const kind of ['view', 'self_assessment'] as const) {
    assert.equal(classifyMeasurement({ ...base, kind }, time(600)).classification, 'unmeasured');
  }
});

test('an objectively scored first recall is eligible only with explicit no-help evidence', () => {
  assert.equal(classifyMeasurement(base, time(600)).classification, 'independent_success');
  assert.equal(
    classifyMeasurement({ ...base, outcome: 'incorrect' }, time(600)).classification,
    'independent_failure',
  );
  for (const help of [undefined, 'unknown'] as const) {
    assert.equal(
      classifyMeasurement({ ...base, help }, time(600)).classification,
      'pending_review',
    );
  }
  assert.equal(
    classifyMeasurement({ ...base, lastAnswerExposureAt: undefined }, time(600)).classification,
    'pending_review',
  );
});

test('visible answers or hints make both correct and incorrect responses supported', () => {
  for (const outcome of ['correct', 'incorrect'] as const) {
    const result = classifyMeasurement({ ...base, outcome, help: 'present' }, time(600));
    assert.equal(result.classification, 'supported');
  }
});

test('immediate copying remains too soon even after another target intervened', () => {
  const input = {
    ...base,
    lastAnswerExposureAt: time(60),
    interveningOtherTarget: true,
  };
  assert.equal(classifyMeasurement(input, time(600)).classification, 'too_soon');
  assert.equal(
    classifyMeasurement({ ...input, occurredAt: time(119.999) }, time(600)).classification,
    'too_soon',
  );
});

test('interleaved recall becomes eligible at 60 seconds after the last answer exposure', () => {
  const result = classifyMeasurement(
    {
      ...base,
      occurredAt: time(120),
      lastAnswerExposureAt: time(60),
      interveningOtherTarget: true,
    },
    time(600),
  );
  assert.equal(result.classification, 'independent_success');
  assert.equal(result.rules.ruleVersion, 'd0-v1');
});

test('one-target recall needs five elapsed minutes when interleaving is absent or unknown', () => {
  for (const interveningOtherTarget of [false, undefined]) {
    const input = { ...base, lastAnswerExposureAt: time(60), interveningOtherTarget };
    assert.equal(
      classifyMeasurement({ ...input, occurredAt: time(359.999) }, time(600)).classification,
      'too_soon',
    );
    assert.equal(
      classifyMeasurement({ ...input, occurredAt: time(360) }, time(600)).classification,
      'independent_success',
    );
  }
});

test('absent answers are never turned into failures, and unverified scores stay pending', () => {
  for (const answerProvided of [false, undefined]) {
    const result = classifyMeasurement(
      { ...base, answerProvided, outcome: 'incorrect' },
      time(600),
    );
    assert.equal(result.classification, 'unmeasured');
  }
  for (const outcome of [null, undefined]) {
    assert.equal(
      classifyMeasurement({ ...base, outcome }, time(600)).classification,
      'pending_review',
    );
  }
  assert.equal(
    classifyMeasurement({ ...base, assessment: 'unverified' }, time(600)).classification,
    'pending_review',
  );
});

test('invalid, future or inconsistent timestamps require review instead of scoring', () => {
  for (const occurredAt of ['', 'not-a-date', '2026-02-30T00:00:00Z', time(601)]) {
    assert.equal(
      classifyMeasurement({ ...base, occurredAt }, time(600)).classification,
      'pending_review',
    );
  }
  assert.equal(classifyMeasurement(base, 'invalid').classification, 'pending_review');
  for (const lastAnswerExposureAt of ['invalid', time(61)]) {
    assert.equal(
      classifyMeasurement({ ...base, lastAnswerExposureAt }, time(600)).classification,
      'pending_review',
    );
  }
});

test('later scoring uses actual answer time and cannot age an immediate copy into success', () => {
  const input = { ...base, lastAnswerExposureAt: time(59), interveningOtherTarget: true };
  assert.equal(classifyMeasurement(input, time(600)).classification, 'too_soon');
  assert.equal(classifyMeasurement(input, time(86_400)).classification, 'too_soon');
});

test('first failure and supported correction remain distinct without mutating either input', () => {
  const first = Object.freeze({ ...base, outcome: 'incorrect' as const });
  const correction = Object.freeze({
    ...base,
    eventId: 'attempt-2',
    occurredAt: time(65),
    help: 'present' as const,
    lastAnswerExposureAt: time(62),
  });
  const before = JSON.stringify([first, correction]);
  const firstResult = classifyMeasurement(first, time(600));
  const correctionResult = classifyMeasurement(correction, time(600));
  assert.equal(firstResult.classification, 'independent_failure');
  assert.equal(correctionResult.classification, 'supported');
  assert.notEqual(firstResult.eventId, correctionResult.eventId);
  assert.equal(JSON.stringify([first, correction]), before);
});

test('meaning and spelling keep separate evidence identities and rules are captured in results', () => {
  const spelling = classifyMeasurement(base, time(600));
  const meaning = classifyMeasurement(
    { ...base, eventId: 'meaning-1', ability: 'meaning' },
    time(600),
  );
  assert.equal(spelling.ability, 'spelling');
  assert.equal(meaning.ability, 'meaning');
  assert.equal(meaning.targetId, spelling.targetId);
  assert.deepEqual(spelling.rules, defaultMeasurementRules);
  assert.notEqual(spelling.rules, defaultMeasurementRules);
  assert.throws(() =>
    classifyMeasurement(base, time(600), {
      ruleVersion: 'invalid',
      minRecallDelayMs: 100,
      minSoloRecallDelayMs: 99,
    }),
  );
});
