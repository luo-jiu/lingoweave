import { z } from 'zod';

export interface MeasurementRules {
  ruleVersion: string;
  minRecallDelayMs: number;
  minSoloRecallDelayMs: number;
}

export const defaultMeasurementRules: Readonly<MeasurementRules> = Object.freeze({
  ruleVersion: 'd0-v1',
  minRecallDelayMs: 60_000,
  minSoloRecallDelayMs: 300_000,
});

export interface MeasurementInput {
  eventId: string;
  targetId: string;
  ability: 'meaning' | 'spelling';
  kind: 'view' | 'self_assessment' | 'attempt';
  occurredAt: string;
  answerProvided?: boolean;
  outcome?: 'correct' | 'incorrect' | null;
  assessment?: 'objective' | 'unverified';
  help?: 'none' | 'present' | 'unknown';
  lastAnswerExposureAt?: string | null;
  interveningOtherTarget?: boolean;
}

export type MeasurementClassification =
  | 'unmeasured'
  | 'pending_review'
  | 'supported'
  | 'too_soon'
  | 'independent_success'
  | 'independent_failure';

function timestamp(value: string): number | null {
  if (!z.iso.datetime({ offset: true }).safeParse(value).success) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Classify one immutable observation; this neither grades an answer nor updates FSRS. */
export function classifyMeasurement(
  input: Readonly<MeasurementInput>,
  evaluatedAt: string,
  rules: Readonly<MeasurementRules> = defaultMeasurementRules,
) {
  if (
    !rules.ruleVersion.trim() ||
    !Number.isSafeInteger(rules.minRecallDelayMs) ||
    rules.minRecallDelayMs < 0 ||
    !Number.isSafeInteger(rules.minSoloRecallDelayMs) ||
    rules.minSoloRecallDelayMs < rules.minRecallDelayMs
  )
    throw new Error('Invalid measurement rules.');

  const result = (classification: MeasurementClassification, reason: string) => ({
    eventId: input.eventId,
    targetId: input.targetId,
    ability: input.ability,
    occurredAt: input.occurredAt,
    rules: { ...rules },
    classification,
    reason,
  });
  const occurred = timestamp(input.occurredAt);
  const evaluated = timestamp(evaluatedAt);
  if (occurred === null || evaluated === null || occurred > evaluated)
    return result('pending_review', 'invalid_time');
  if (input.kind !== 'attempt') return result('unmeasured', 'not_an_attempt');
  if (input.answerProvided !== true) return result('unmeasured', 'no_answer');
  if (input.outcome !== 'correct' && input.outcome !== 'incorrect')
    return result('pending_review', 'unscored_answer');
  if (input.assessment !== 'objective') return result('pending_review', 'unverified_assessment');
  if (input.help !== 'none' && input.help !== 'present')
    return result('pending_review', 'unknown_help');
  const exposure = input.lastAnswerExposureAt;
  const exposed = typeof exposure === 'string' ? timestamp(exposure) : null;
  if (typeof exposure === 'string' && (exposed === null || exposed > occurred))
    return result('pending_review', 'invalid_exposure_time');
  if (input.help === 'present') return result('supported', 'answer_help_present');
  if (exposure === undefined) return result('pending_review', 'unknown_exposure');
  if (exposed !== null) {
    const elapsed = occurred - exposed;
    if (elapsed < rules.minRecallDelayMs) return result('too_soon', 'minimum_delay_not_met');
    if (input.interveningOtherTarget !== true && elapsed < rules.minSoloRecallDelayMs)
      return result('too_soon', 'solo_delay_not_met');
  }
  return result(
    input.outcome === 'correct' ? 'independent_success' : 'independent_failure',
    'objective_independent_recall',
  );
}
