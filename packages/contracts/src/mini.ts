import { z } from 'zod';
import { miniAssessmentSourceSchema, miniExpressionGradeSchema } from './mini-assessment.js';
import { miniAiSelectionSchema } from './mini-ai-selection.js';
import {
  miniFlowSchedulingSchema,
  miniFlowScheduleCardSchema,
  defaultMiniFlowScheduling,
} from './mini-flow-scheduling.js';

const timestamp = z
  .number()
  .finite()
  .refine(
    (value) => Number.isFinite(new Date((value + 978_307_200) * 1000).getTime()),
    'Invalid Swift date',
  );
const text = z.string().max(100_000);
const teachingId = z.uuid().transform((value) => value.toLowerCase());
export const miniTimezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Expected an IANA timezone');
export const miniWordSchema = z
  .object({
    spelling: z.string().min(1).max(500),
    meaning: z.string().max(5000),
    phonetic: z.string().max(1000),
  })
  .strict();
export type MiniWord = z.infer<typeof miniWordSchema>;
export const miniJudgmentSchema = z.enum(['forgotten', 'fuzzy', 'clear']);
const judgmentEventSchema = z
  .object({
    word: miniWordSchema,
    selected: miniJudgmentSchema,
    selectedAt: timestamp,
    final: miniJudgmentSchema.optional(),
    finalizedAt: timestamp.optional(),
  })
  .strict();
const spellingAttemptSchema = z
  .object({
    word: miniWordSchema,
    encounter: z.number().int().positive(),
    kind: z.enum(['first', 'correction']),
    answer: text,
    correct: z.boolean(),
    submittedAt: timestamp,
    lastAnswerRevealAt: timestamp.optional(),
    lastPotentialHelpAt: timestamp.optional(),
    helpDuringAttempt: z.literal(true).optional(),
    revealedAnswerAt: timestamp.optional(),
  })
  .strict();
export const miniWindowVisitSchema = z
  .object({
    id: teachingId,
    word: miniWordSchema,
    stage: z.number().int().min(0).max(2),
    openedAt: timestamp,
    initial: z.boolean().optional(),
    selectedAt: timestamp.optional(),
    revealedAt: timestamp.optional(),
    correctedAt: timestamp.optional(),
    draft: text,
  })
  .strict();
export const miniWindowEventSchema = miniWindowVisitSchema.extend({
  selfReportedFamiliar: z.literal(true).optional(),
  remembered: z.boolean(),
  confirmedAt: timestamp,
  sequence: z.number().int().positive(),
});
export const miniWindowSchema = z
  .object({
    version: z.literal('interleaved-v2'),
    size: z.literal(5),
    gap: z.literal(3),
    members: z
      .array(
        z
          .object({
            word: miniWordSchema,
            stage: z.number().int().min(0).max(2),
            admittedAt: timestamp,
            lastVisit: z.number().int().positive().nullable(),
          })
          .strict(),
      )
      .max(5),
    visit: miniWindowVisitSchema.nullable(),
    events: z.array(miniWindowEventSchema),
    sequence: z.number().int().nonnegative(),
    forceUnseen: z.boolean(),
  })
  .strict();
export type MiniWindow = z.infer<typeof miniWindowSchema>;
export type MiniWindowVisit = z.infer<typeof miniWindowVisitSchema>;
export type MiniWindowEvent = z.infer<typeof miniWindowEventSchema>;
export const miniReviewSessionSchema = z
  .object({
    words: z.array(miniWordSchema),
    queue: z.array(miniWordSchema),
    fullBatchSpelling: z.boolean().optional(),
    spellingPolicy: z.enum(['retry-errors-v1', 'retry-errors-v2']).optional(),
    spellingRounds: z
      .array(
        z
          .object({
            round: z.number().int().positive(),
            order: z.array(z.number().int().nonnegative()).min(2),
          })
          .strict(),
      )
      .min(1)
      .optional(),
    relearning: miniWindowSchema.optional(),
    relearningWords: z.array(miniWordSchema).optional(),
    phase: z.enum(['judgment', 'spelling', 'finished']),
    judgmentEvents: z.array(judgmentEventSchema),
    spellingAttempts: z.array(spellingAttemptSchema),
    spellingPromptAt: timestamp.optional(),
    spellingState: z.enum(['awaitingFirst', 'correcting', 'readyToAdvance', 'skipped']),
    spellingDraft: text,
    spellingSkips: z
      .array(
        z
          .object({
            word: miniWordSchema,
            round: z.union([z.literal(3), z.literal(5)]),
            at: timestamp,
          })
          .strict(),
      )
      .optional(),
    clearedJudgments: z.array(judgmentEventSchema.extend({ clearedAt: timestamp })).optional(),
  })
  .strict();
export type MiniReviewSession = z.infer<typeof miniReviewSessionSchema>;
export const miniSentenceSchema = z
  .object({
    word: miniWordSchema,
    english: text,
    chinese: text,
    targetForms: z.array(z.string().trim().min(1).max(200)).min(1).max(5).optional(),
    source: z
      .object({
        id: z.string().min(1).max(200),
        title: z.string().min(1).max(200),
        url: z.url(),
        locator: z.string().min(1).max(200),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((sentence, context) => {
    for (const form of sentence.targetForms ?? []) {
      const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (
        !new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(
          sentence.english,
        )
      )
        context.addIssue({
          code: 'custom',
          path: ['targetForms'],
          message: 'Target forms must occur as complete words in the sentence.',
        });
    }
  });
export type MiniSentence = z.infer<typeof miniSentenceSchema>;
export const miniFeedbackSchema = z
  .object({
    outcome: z.enum(['correct', 'partial', 'incorrect']).optional(),
    expressionGrade: miniExpressionGradeSchema.optional(),
    comment: text,
    tip: text,
    usefulPhrase: text,
    strengths: z.array(text).max(10).optional(),
    improvements: z.array(text).max(10).optional(),
    keyPoints: z.array(text).max(10).optional(),
    referenceTranslation: text.optional(),
  })
  .strict();
export const miniQualitativeFeedbackSchema = miniFeedbackSchema
  .omit({ outcome: true })
  .extend({
    strengths: z.array(text).max(10),
    improvements: z.array(text).max(10),
    keyPoints: z.array(text).max(10),
    referenceTranslation: text,
  })
  .strict();
// Older persisted tool commands and their receipts replay this original action shape.
const qualitativeFeedbackAction = z
  .object({
    type: z.literal('qualitative_feedback'),
    target: z.literal('daily'),
    dayId: z.string(),
    attemptId: z.uuid(),
    feedback: miniQualitativeFeedbackSchema,
  })
  .strict();
export const miniNewFeedbackActionSchema = qualitativeFeedbackAction.extend({
  feedback: miniQualitativeFeedbackSchema.required({ expressionGrade: true }),
});

export const miniWritingPromptInputSchema = z
  .object({
    id: teachingId,
    sentence: miniSentenceSchema,
    direction: z.enum(['englishToChinese', 'chineseToEnglish']),
    focusIds: z.array(teachingId).max(2),
  })
  .strict();
export const miniWritingPromptSchema = miniWritingPromptInputSchema.extend({
  createdAt: timestamp,
});
export type MiniWritingPrompt = z.infer<typeof miniWritingPromptSchema>;
export const miniTranslationTaskSchema = z
  .object({
    id: z.string().min(1).max(200),
    sentence: miniSentenceSchema,
    direction: z.enum(['englishToChinese', 'chineseToEnglish']),
    materialId: teachingId.optional(),
    focusIds: z.array(teachingId).max(2).optional(),
  })
  .strict();
export type MiniTranslationTask = z.infer<typeof miniTranslationTaskSchema>;
export const miniTranslationAttemptSchema = z
  .object({
    id: z.uuid(),
    task: miniTranslationTaskSchema,
    answer: text,
    submittedAt: timestamp,
    feedback: miniFeedbackSchema.optional(),
    gradedAt: timestamp.optional(),
    confirmedAt: timestamp.optional(),
    revisions: z
      .array(
        z
          .object({
            id: teachingId,
            answer: z.string().trim().min(1).max(4000),
            submittedAt: timestamp,
            aiSelection: miniAiSelectionSchema.optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export const miniScheduleSchema = z
  .object({
    word: miniWordSchema,
    dueAt: timestamp,
    step: z.number().int().min(0).max(4),
    recordedAt: timestamp,
    source: z.enum(['review', 'learning', 'translation']),
    policyVersion: z.literal(1),
  })
  .strict();
export type MiniSchedule = z.infer<typeof miniScheduleSchema>;
const memoryRound = z.number().int().min(1).max(3);
export const miniMemoryRoundsSchema = z
  .object({
    version: z.literal('three-rounds-v1'),
    round: z.number().int().min(1).max(4),
    queue: z.array(miniWordSchema),
    progress: z.array(
      z.object({ word: miniWordSchema, completedRounds: z.number().int().min(0).max(3) }).strict(),
    ),
    events: z.array(
      z
        .object({
          id: teachingId,
          word: miniWordSchema,
          round: memoryRound,
          remembered: z.boolean(),
          at: timestamp,
          undoneAt: timestamp.optional(),
        })
        .strict(),
    ),
    drafts: z.array(
      z.object({ word: miniWordSchema, round: memoryRound, text, updatedAt: timestamp }).strict(),
    ),
    reveals: z.array(
      z
        .object({
          word: miniWordSchema,
          round: memoryRound,
          at: timestamp,
          beforeEventCount: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    revealed: z.boolean(),
  })
  .strict();
export type MiniMemoryRounds = z.infer<typeof miniMemoryRoundsSchema>;
export const miniFlowSchema = z
  .object({
    version: z.literal('sliding-window-v2'),
    targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dailyNewGoal: z.number().int().min(0).max(200),
    // One explicitly requested group on targetDate. The plan's daily goal stays unchanged.
    extraGroupTarget: z.number().int().positive().optional(),
    completedBeforeRun: z.number().int().nonnegative(),
    groupSize: z.number().int().min(1).max(50),
    candidates: z.array(miniWordSchema).max(100_000),
    candidateIndex: z.number().int().nonnegative(),
    window: miniWindowSchema,
    groupId: teachingId,
    groupIndex: z.number().int().positive(),
    groupStartedAt: timestamp,
    groupTarget: z.number().int().min(0).max(50),
    groupWords: z.array(miniWordSchema).max(50),
    translationWords: z.array(miniWordSchema),
    groups: z.array(
      z
        .object({
          id: teachingId,
          index: z.number().int().positive(),
          words: z.array(miniWordSchema).max(50),
          startedAt: timestamp,
          finishedAt: timestamp,
          spelling: miniReviewSessionSchema,
          translationAttemptIds: z.array(teachingId),
        })
        .strict(),
    ),
    completed: z.array(
      z
        .object({
          word: miniWordSchema,
          attemptId: teachingId,
          at: timestamp,
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        })
        .strict(),
    ),
    goalReached: z.boolean(),
  })
  .strict();
export type MiniFlow = z.infer<typeof miniFlowSchema>;
export const miniDaySchema = z
  .object({
    id: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}(?:~[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/,
      ),
    startedAt: timestamp,
    timezone: miniTimezoneSchema.optional(),
    archivedAt: timestamp.optional(),
    writingRequired: z.boolean().optional(),
    reviewWords: z.array(miniWordSchema).max(100_000),
    learningWords: z.array(miniWordSchema).max(100_000),
    reviewSteps: z.array(z.number().int().min(0).max(4)),
    directions: z.array(z.enum(['englishToChinese', 'chineseToEnglish'])),
    review: miniReviewSessionSchema.optional(),
    learning: miniReviewSessionSchema.optional(),
    memory: miniMemoryRoundsSchema.optional(),
    flow: miniFlowSchema.optional(),
    paused: z.boolean(),
    pauseEvents: z.array(z.object({ paused: z.boolean(), at: timestamp }).strict()).optional(),
    phase: z.enum(['review', 'learning', 'translation', 'finished']),
    reviewFinishedAt: timestamp.optional(),
    learningStartedAt: timestamp.optional(),
    learningFinishedAt: timestamp.optional(),
    translationStartedAt: timestamp.optional(),
    finishedAt: timestamp.optional(),
    studiedWords: z.array(z.object({ word: miniWordSchema, at: timestamp }).strict()),
    studyMarkEvents: z
      .array(z.object({ word: miniWordSchema, remembered: z.boolean(), at: timestamp }).strict())
      .optional(),
    retainedLearningWord: miniWordSchema.optional(),
    schedulerPolicy: z.literal('fsrs-v1').optional(),
    sentences: z.array(miniSentenceSchema),
    writingMode: z.enum(['prepared', 'legacy']).optional(),
    writingPrompts: z.array(miniWritingPromptSchema).max(100_000).optional(),
    translation: z.array(miniTranslationAttemptSchema),
    translationDraft: text,
    translationIndex: z.number().int().nonnegative(),
    scheduleUpdates: z.array(miniScheduleSchema),
  })
  .strict()
  .superRefine((day, context) => {
    if (day.flow) return;
    if (day.reviewWords.length > 5 || day.learningWords.length > 5)
      context.addIssue({ code: 'custom', message: '旧版固定组最多包含 5 个复习词和 5 个新词。' });
    if ((day.writingPrompts?.length ?? 0) > 10)
      context.addIssue({
        code: 'custom',
        path: ['writingPrompts'],
        message: '旧版写作材料不能超过固定组容量。',
      });
  });
export type MiniDay = z.infer<typeof miniDaySchema>;
export const miniLedgerSchema = z.object({ days: z.array(miniDaySchema) }).strict();
export type MiniLedger = z.infer<typeof miniLedgerSchema>;
export const miniReviewRecordSchema = z
  .object({
    id: z.uuid(),
    session: miniReviewSessionSchema,
    paused: z.boolean(),
    continuedToLearning: z.boolean(),
    nextWordIndex: z.number().int().nonnegative(),
  })
  .strict();
export type MiniReviewRecord = z.infer<typeof miniReviewRecordSchema>;
const planLimits = {
  wordLimit: z.number().int().min(1).max(10),
  newWordLimit: z.number().int().min(0).max(5),
};
export const miniPlanLimitsSchema = z.object(planLimits).strict();
export type MiniPlanLimits = z.infer<typeof miniPlanLimitsSchema>;
export const miniLongTermPlanSchema = z
  .object({
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, 'Weekdays must be unique'),
    ...planLimits,
    dailyNewGoal: z.number().int().min(0).max(200).optional(),
    groupSize: z.number().int().min(1).max(50).optional(),
  })
  .strict();
export type MiniLongTermPlan = z.infer<typeof miniLongTermPlanSchema>;
const planDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'Invalid calendar date');
export const miniDailyPlanSchema = z
  .object({
    date: planDate,
    timezone: miniTimezoneSchema,
    mode: z.enum(['normal', 'reviewOnly', 'rest']),
    ...planLimits,
    dailyNewGoal: z.number().int().min(0).max(200).optional(),
    groupSize: z.number().int().min(1).max(50).optional(),
  })
  .strict();
export type MiniDailyPlan = z.infer<typeof miniDailyPlanSchema>;
export const miniPlanSessionSchema = z
  .object({
    id: z.uuid(),
    dayId: z.string(),
    timezone: miniTimezoneSchema,
    startedAt: timestamp,
    ...planLimits,
    servedWords: z.array(miniWordSchema).max(100000),
    newWords: z.array(miniWordSchema).max(100000).optional(),
    source: z.enum(['default', 'today', 'session', 'recovery']).optional(),
    intent: z.enum(['review', 'learn']).optional(),
    overrideRest: z.boolean().optional(),
    // Original mixed run to return to after a temporary rest-day study traverses review groups.
    restStudyDayId: z.string().optional(),
    endedAt: timestamp.optional(),
    pauseReason: z.enum(['manual', 'budget', 'rest', 'ended']).optional(),
  })
  .strict();
export type MiniPlanSession = z.infer<typeof miniPlanSessionSchema>;
export function defaultMiniPlanning() {
  return {
    longTerm: {
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      wordLimit: 10,
      newWordLimit: 5,
    },
    activeDayId: null,
    dailyOverrides: [],
    nextSessionOverride: null,
    sessions: [],
  };
}
export const miniPlanningSchema = z
  .object({
    longTerm: miniLongTermPlanSchema,
    activeDayId: z.string().nullable().default(null),
    dailyOverrides: z.array(miniDailyPlanSchema),
    nextSessionOverride: miniPlanLimitsSchema.nullable(),
    sessions: z.array(miniPlanSessionSchema),
  })
  .strict();
export type MiniPlanning = z.infer<typeof miniPlanningSchema>;
export const miniFocusStatusSchema = z.enum(['active', 'deferred', 'archived']);
export const miniFocusItemSchema = z
  .object({
    id: teachingId,
    senseIds: z
      .array(z.string().regex(/^sense-[0-9a-f]{64}$/))
      .min(1)
      .max(5),
    words: z.array(miniWordSchema).min(1).max(5),
    expression: z.string().trim().min(1).max(500),
    explanation: z.string().trim().min(1).max(2000),
    status: miniFocusStatusSchema,
    source: z.object({ dayId: z.string(), attemptId: z.uuid().optional() }).strict(),
    reason: z.string().trim().min(1).max(2000),
    createdAt: timestamp,
    updatedAt: timestamp,
    changes: z.array(
      z
        .object({
          status: miniFocusStatusSchema,
          explanation: z.string().trim().min(1).max(2000),
          reason: z.string().trim().min(1).max(2000),
          at: timestamp,
        })
        .strict(),
    ),
  })
  .strict();
export type MiniFocusItem = z.infer<typeof miniFocusItemSchema>;
export const miniMemorySchema = z
  .object({
    id: teachingId,
    key: z.string().trim().min(1).max(100),
    value: z.string().trim().min(1).max(2000),
    sourceMessageId: z.string().min(1).max(200),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type MiniMemory = z.infer<typeof miniMemorySchema>;
export const miniExposureSchema = z
  .object({
    id: teachingId,
    target: z.enum(['daily', 'review']),
    dayId: z.string().optional(),
    recordId: z.uuid().optional(),
    session: z.enum(['review', 'learning']).optional(),
    word: miniWordSchema,
    kind: z.enum(['potentialHelp', 'answerReveal', 'focusView']),
    source: z.enum(['chat', 'ui', 'feedback', 'audio']),
    audioKind: z.enum(['word', 'sentence']).optional(),
    taskId: z.string().min(1).max(200).optional(),
    visibleSentence: z.object({ english: text, chinese: text }).strict().optional(),
    reviewPrompt: z.literal(true).optional(),
    spellingAttemptHelp: z.literal(true).optional(),
    translationPromptAudio: z.literal(true).optional(),
    focusIds: z.array(teachingId).max(2),
    sourceMessageId: z.string().min(1).max(200).optional(),
    beforeAttemptCount: z.number().int().nonnegative(),
    beforeJudgmentCount: z.number().int().nonnegative().optional(),
    at: timestamp,
  })
  .strict()
  .superRefine((exposure, context) => {
    if (
      exposure.reviewPrompt &&
      (exposure.source !== 'ui' ||
        exposure.kind !== 'potentialHelp' ||
        exposure.session !== 'review' ||
        exposure.visibleSentence !== undefined ||
        exposure.focusIds.length > 0 ||
        exposure.sourceMessageId !== undefined ||
        exposure.taskId !== undefined)
    )
      context.addIssue({
        code: 'custom',
        path: ['reviewPrompt'],
        message: 'reviewPrompt requires the bare word on a review judgment card',
      });
    if (exposure.audioKind !== undefined && exposure.source !== 'audio')
      context.addIssue({
        code: 'custom',
        path: ['audioKind'],
        message: 'audioKind requires an audio exposure',
      });
  });
export type MiniExposure = z.infer<typeof miniExposureSchema>;
export function defaultMiniTeaching() {
  return { focusItems: [], memories: [], exposures: [] };
}
export const miniFsrsCardSchema = z
  .object({
    due: timestamp,
    stability: z.number().nonnegative(),
    difficulty: z.number().nonnegative(),
    elapsed_days: z.number().nonnegative(),
    scheduled_days: z.number().nonnegative(),
    learning_steps: z.number().int().nonnegative(),
    reps: z.number().int().nonnegative(),
    lapses: z.number().int().nonnegative(),
    state: z.number().int().min(0).max(3),
    last_review: timestamp.optional(),
  })
  .strict();
export const miniMemoryCardSchema = z
  .object({
    senseId: z.string(),
    word: miniWordSchema,
    ability: z.literal('spelling'),
    introducedAt: timestamp,
    dueAt: timestamp,
    nextProbeAt: timestamp.optional(),
    practicePriority: z.number().int().min(0).max(5).optional(),
    priorityUpdatedAt: timestamp.optional(),
    lastServedAt: timestamp.nullable(),
    exposureKnown: z.boolean(),
    lastAnswerExposureAt: timestamp.nullable(),
    lastMeaningExposureAt: timestamp.nullable().optional(),
    state: z.enum(['introduced', 'learning', 'review', 'relearning']),
    fsrs: miniFsrsCardSchema.nullable(),
  })
  .strict();
export const miniFsrsParametersSchema = z
  .object({
    requestRetention: z.literal(0.9),
    maximumInterval: z.literal(36500).default(36500),
    enableFuzz: z.literal(false),
    enableShortTerm: z.literal(true),
    learningSteps: z.array(z.literal('10m')),
    relearningSteps: z.array(z.literal('10m')),
    weights: z.array(z.number()),
  })
  .strict();
export const miniProbeSchema = z
  .object({
    id: teachingId,
    word: miniWordSchema,
    openedAt: timestamp,
    exposureCountAtOpen: z.number().int().nonnegative().default(0),
    status: z.enum(['active', 'answered', 'ended']),
    endedAt: timestamp.optional(),
    revealedAt: timestamp.optional(),
    answer: text.optional(),
    helpAt: timestamp.optional(),
    helpSources: z.array(z.enum(['chat', 'audio', 'ui'])).default([]),
    submittedAt: timestamp.optional(),
    correct: z.boolean().optional(),
    classification: z
      .enum([
        'unmeasured',
        'pending_review',
        'supported',
        'too_soon',
        'independent_success',
        'independent_failure',
      ])
      .optional(),
    reason: z.string().optional(),
    rating: z.enum(['Good', 'Again']).optional(),
    dueAt: timestamp.optional(),
    exposureKnown: z.boolean(),
    lastAnswerExposureAt: timestamp.nullable(),
    measurement: z
      .object({
        ruleVersion: z.string(),
        minRecallDelayMs: z.number(),
        minSoloRecallDelayMs: z.number(),
        help: z.enum(['none', 'present', 'unknown']),
        interveningOtherTarget: z.boolean(),
        lastAnswerExposureAt: timestamp.nullable(),
      })
      .strict()
      .optional(),
    scheduleBefore: miniFsrsCardSchema.nullable().optional(),
    scheduleAfter: miniFsrsCardSchema.optional(),
    schedulerVersion: z.literal('ts-fsrs@5.4.2/FSRS-6').optional(),
    parameters: miniFsrsParametersSchema.optional(),
  })
  .strict();
export const miniSchedulingSchema = z
  .object({
    policyVersion: z.literal('mini-fsrs-v1'),
    flow: miniFlowSchedulingSchema.default(defaultMiniFlowScheduling),
    libraryVersion: z.literal('5.4.2'),
    model: z.literal('FSRS-6'),
    parameters: miniFsrsParametersSchema,
    cards: z.array(miniMemoryCardSchema),
    probes: z.array(miniProbeSchema),
    activeProbeId: teachingId.nullable(),
    visibleWord: miniWordSchema.nullable().default(null),
    visibleTranslationPrompt: z.string().optional(),
    views: z
      .array(
        z
          .object({
            id: teachingId,
            word: miniWordSchema,
            at: timestamp,
            translationPrompt: z.string().optional(),
            lookup: z.literal(true).optional(),
          })
          .strict(),
      )
      .default([]),
    servedCount: z.number().int().nonnegative(),
  })
  .strict();
export function defaultMiniScheduling(): z.infer<typeof miniSchedulingSchema> {
  return {
    policyVersion: 'mini-fsrs-v1',
    flow: defaultMiniFlowScheduling(),
    libraryVersion: '5.4.2',
    model: 'FSRS-6',
    parameters: {
      requestRetention: 0.9,
      maximumInterval: 36500,
      enableFuzz: false,
      enableShortTerm: true,
      learningSteps: ['10m'],
      relearningSteps: ['10m'],
      weights: [],
    },
    cards: [],
    probes: [],
    activeProbeId: null,
    visibleWord: null,
    views: [],
    servedCount: 0,
  };
}
export const miniDictationSchema = z
  .object({
    id: teachingId,
    target: z.enum(['daily', 'review']),
    dayId: z.string().optional(),
    recordId: teachingId.optional(),
    session: z.enum(['review', 'learning']).optional(),
    word: miniWordSchema,
    openedAt: timestamp,
    closedAt: timestamp.optional(),
    revealedAt: timestamp.optional(),
    attempts: z.array(
      z
        .object({ id: teachingId, answer: text, correct: z.boolean(), submittedAt: timestamp })
        .strict(),
    ),
  })
  .strict();
export const miniPracticeSchema = z
  .object({ activeDictationId: teachingId.nullable(), dictations: z.array(miniDictationSchema) })
  .strict();
export function defaultMiniPractice() {
  return { activeDictationId: null, dictations: [] };
}
export type MiniMemoryCard = z.infer<typeof miniMemoryCardSchema>;
export type MiniProbe = z.infer<typeof miniProbeSchema>;
export type MiniScheduling = z.infer<typeof miniSchedulingSchema>;
export type MiniDictation = z.infer<typeof miniDictationSchema>;
export const miniTeachingSchema = z
  .object({
    focusItems: z.array(miniFocusItemSchema),
    memories: z.array(miniMemorySchema).max(20),
    exposures: z.array(miniExposureSchema),
  })
  .strict();
export type MiniTeaching = z.infer<typeof miniTeachingSchema>;
export const miniSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    imported: z.boolean(),
    assessmentSources: z.array(miniAssessmentSourceSchema).default([]),
    ledger: miniLedgerSchema,
    reviewRecord: miniReviewRecordSchema.nullable(),
    reviewHistory: z.array(miniReviewRecordSchema),
    planning: miniPlanningSchema.default(defaultMiniPlanning),
    teaching: miniTeachingSchema.default(defaultMiniTeaching),
    scheduling: miniSchedulingSchema.default(defaultMiniScheduling),
    practice: miniPracticeSchema.default(defaultMiniPractice),
  })
  .strict();
export type MiniSnapshot = z.infer<typeof miniSnapshotSchema>;
export const miniPlanPreviewInputSchema = z
  .object({ deck: z.array(miniWordSchema).max(100_000), timezone: miniTimezoneSchema })
  .strict();
export type MiniPlanPreviewInput = z.infer<typeof miniPlanPreviewInputSchema>;
export const miniPlanContextSchema = z
  .object({
    date: planDate,
    timezone: miniTimezoneSchema,
    effective: z
      .object({
        mode: z.enum(['normal', 'reviewOnly', 'rest']),
        ...planLimits,
        dailyNewGoal: z.number().int().min(0).max(200).optional(),
        groupSize: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
    completedNewCount: z.number().int().nonnegative().optional(),
    wordProgress: z
      .object({
        lifetime: z.number().int().nonnegative(),
        bookId: z.string().nullable(),
        completed: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    remainingNewCount: z.number().int().nonnegative().optional(),
    todayCompleted: z.boolean(),
    canStartReview: z.boolean().optional(),
    canStartLearning: z.boolean().optional(),
    canStartExtraGroup: z.boolean(),
    extraGroupWordCount: z.number().int().min(0).max(50),
    activeExtraGroupWordCount: z.number().int().min(1).max(50).optional(),
    hasDueReviews: z.boolean().optional(),
    todayOverride: miniDailyPlanSchema.nullable(),
    dueCount: z.number().int().nonnegative(),
    newCount: z.number().int().nonnegative(),
    lastActivityAt: timestamp.nullable(),
    absenceDays: z.number().int().nonnegative(),
    recoverySuggested: z.boolean(),
    recoveryWordLimit: z.number().int().min(1).max(10),
    pendingDayId: z.string().nullable(),
    pendingGroups: z.array(
      z
        .object({
          dayId: z.string(),
          phase: z.enum(['review', 'learning', 'translation']),
          paused: z.boolean(),
          startedAt: timestamp,
          canContinue: z.boolean(),
          blockedReason: z.string().nullable(),
        })
        .strict(),
    ),
    canStart: z.boolean(),
    canContinue: z.boolean(),
    blockedReason: z.string().nullable(),
  })
  .strict();
export type MiniPlanContext = z.infer<typeof miniPlanContextSchema>;
export const miniPlanPreviewSchema = miniSnapshotSchema.extend({
  planContext: miniPlanContextSchema,
});
export type MiniPlanPreview = z.infer<typeof miniPlanPreviewSchema>;
export const miniHistoryKindSchema = z.enum([
  'all',
  'judgment',
  'view',
  'spelling',
  'translation',
  'feedback',
  'material',
  'plan',
  'exposure',
  'probe',
  'dictation',
  'memory',
  'spelling_skip',
]);
export const miniHistoryCursorSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    filter: z.string(),
  })
  .strict();
export const miniHistoryInputSchema = z
  .object({
    kind: miniHistoryKindSchema.default('all'),
    dayId: z.string().optional(),
    word: miniWordSchema.optional(),
    cursor: miniHistoryCursorSchema.optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export type MiniHistoryInput = z.input<typeof miniHistoryInputSchema>;
export const miniHistoryItemSchema = z
  .object({
    id: z.string(),
    kind: miniHistoryKindSchema.exclude(['all']),
    at: timestamp,
    dayId: z.string().optional(),
    recordId: z.uuid().optional(),
    session: z.enum(['review', 'learning']).optional(),
    word: miniWordSchema.optional(),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
export type MiniHistoryItem = z.infer<typeof miniHistoryItemSchema>;
export const miniHistoryPageSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    items: z.array(miniHistoryItemSchema).max(50),
    nextCursor: miniHistoryCursorSchema.nullable(),
  })
  .strict();
export type MiniHistoryPage = z.infer<typeof miniHistoryPageSchema>;
export const miniAIContextInputSchema = z
  .object({ timezone: miniTimezoneSchema, dayId: z.string().optional() })
  .strict();
export type MiniAIContextInput = z.infer<typeof miniAIContextInputSchema>;
export const miniActivitySummarySchema = z
  .object({
    activityDays: z.number().int().nonnegative(),
    lastActivityAt: timestamp.nullable(),
    viewedLexemes: z.number().int().nonnegative(),
    firstSpellingAttempts: z.number().int().nonnegative(),
    translationAttempts: z.number().int().nonnegative(),
    memoryRoundAdvances: z.number().int().nonnegative().optional(),
    familiarityDeclarations: z.number().int().nonnegative().optional(),
    skippedSpellingWords: z.number().int().nonnegative().optional(),
    highPriorityWords: z.number().int().nonnegative().optional(),
    coverage: z.literal('recorded_events_only'),
  })
  .strict();
export const miniAIContextSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    date: planDate,
    timezone: miniTimezoneSchema,
    planning: miniPlanningSchema,
    day: miniDaySchema.nullable(),
    currentTask: miniTranslationTaskSchema.nullable(),
    currentLearning: z
      .object({
        word: miniWordSchema,
        stage: z.enum(['initial', 'context', 'meaning', 'spelling']),
        round: z.number().int().min(1).max(4),
        completedRounds: z.number().int().min(0).max(3),
        revealed: z.boolean(),
      })
      .strict()
      .optional(),
    currentProbe: miniProbeSchema.nullable(),
    currentDictation: miniDictationSchema.nullable(),
    focusItems: z.array(miniFocusItemSchema),
    memories: z.array(miniMemorySchema).max(20),
    summary: miniActivitySummarySchema,
    focusBudget: z
      .object({
        activePerSense: z.literal(2),
        newPerDay: z.literal(1),
        remainingForDay: z.number().int().min(0).max(1),
      })
      .strict(),
  })
  .strict();
export type MiniAIContext = z.infer<typeof miniAIContextSchema>;
export const miniWordContextInputSchema = z
  .object({ word: miniWordSchema, limit: z.number().int().min(1).max(50).default(20) })
  .strict();
export type MiniWordContextInput = z.input<typeof miniWordContextInputSchema>;
export const miniWordContextSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    senseId: z.string(),
    word: miniWordSchema,
    memory: miniMemoryCardSchema.nullable(),
    flowMemory: miniFlowScheduleCardSchema.nullable().optional(),
    probes: z.array(miniProbeSchema),
    dictations: z.array(miniDictationSchema),
    focusItems: z.array(miniFocusItemSchema),
    history: miniHistoryPageSchema,
    focusBudget: z
      .object({ active: z.number().int().nonnegative(), maximum: z.literal(2) })
      .strict(),
  })
  .strict();
export type MiniWordContext = z.infer<typeof miniWordContextSchema>;
export const miniImportSchema = z
  .object({
    requestId: z.uuid(),
    ledger: miniLedgerSchema,
    reviewRecord: miniReviewRecordSchema.nullable().default(null),
    reviewHistory: z.array(miniReviewRecordSchema),
    timezone: miniTimezoneSchema.optional(),
  })
  .strict();
export type MiniImport = z.infer<typeof miniImportSchema>;
const context = {
  target: z.enum(['daily', 'review']),
  dayId: z.string().optional(),
  recordId: z.uuid().optional(),
  session: z.enum(['review', 'learning']).optional(),
};
const contextual = z.object(context);
export const miniActionSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        type: z.literal('begin'),
        target: z.enum(['daily', 'review']),
        deck: z.array(miniWordSchema).max(100_000),
        timezone: miniTimezoneSchema,
        startIndex: z.number().int().nonnegative().optional(),
        dayId: z.string().optional(),
        intent: z.enum(['review', 'learn']).optional(),
        recovery: z.boolean().optional(),
        overrideRest: z.boolean().optional(),
        newGroup: z.boolean().optional(),
        extraGroupForDate: planDate.optional(),
        flowVersion: z.enum(['memory-rounds-v1', 'sliding-window-v2']).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('set_long_term_plan'),
        target: z.literal('daily'),
        plan: miniLongTermPlanSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal('set_today_plan'),
        target: z.literal('daily'),
        ...miniDailyPlanSchema.shape,
      })
      .strict(),
    z
      .object({
        type: z.literal('clear_today_plan'),
        target: z.literal('daily'),
        date: planDate,
        timezone: miniTimezoneSchema,
      })
      .strict(),
    z
      .object({ type: z.literal('set_session_plan'), target: z.literal('daily'), ...planLimits })
      .strict(),
    z.object({ type: z.literal('clear_session_plan'), target: z.literal('daily') }).strict(),
    z
      .object({
        type: z.literal('remember_preference'),
        target: z.literal('daily'),
        key: z.string().trim().min(1).max(100),
        value: z.string().trim().min(1).max(2000),
        sourceMessageId: z.string().min(1).max(200),
      })
      .strict(),
    z
      .object({
        type: z.literal('forget_preference'),
        target: z.literal('daily'),
        memoryId: teachingId,
        sourceMessageId: z.string().min(1).max(200),
      })
      .strict(),
    z
      .object({
        type: z.literal('create_focus'),
        target: z.literal('daily'),
        dayId: z.string(),
        words: z.array(miniWordSchema).min(1).max(5),
        expression: z.string().trim().min(1).max(500),
        explanation: z.string().trim().min(1).max(2000),
        reason: z.string().trim().min(1).max(2000),
        sourceAttemptId: z.uuid().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('update_focus'),
        target: z.literal('daily'),
        dayId: z.string(),
        focusId: teachingId,
        status: miniFocusStatusSchema,
        explanation: z.string().trim().min(1).max(2000).optional(),
        reason: z.string().trim().min(1).max(2000),
      })
      .strict(),
    contextual
      .extend({
        type: z.literal('record_exposure'),
        word: miniWordSchema,
        kind: z.enum(['potentialHelp', 'answerReveal', 'focusView']),
        source: z.enum(['chat', 'ui', 'feedback', 'audio']),
        audioKind: z.enum(['word', 'sentence']).optional(),
        spellingResultAt: timestamp.optional(),
        translationPromptAudio: z.literal(true).optional(),
        taskId: z.string().min(1).max(200).optional(),
        focusIds: z.array(teachingId).max(2).default([]),
        sourceMessageId: z.string().min(1).max(200).optional(),
      })
      .strict(),
    contextual.extend({ type: z.literal('end_session') }).strict(),
    contextual
      .extend({
        type: z.literal('record_card_view'),
        word: miniWordSchema,
        taskId: z.string().min(1).max(200).optional(),
        visibleSentence: miniSentenceSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('record_browse_views'),
        target: z.literal('daily'),
        words: z
          .array(miniWordSchema)
          .min(1)
          .max(64)
          .refine(
            (words) =>
              words.every((word) => word.spelling.trim().length > 0) &&
              new Set(
                words.map((word) =>
                  JSON.stringify([word.spelling.trim().toLowerCase(), word.meaning.trim()]),
                ),
              ).size === words.length,
            'Expected distinct visible word senses',
          ),
      })
      .strict(),
    z
      .object({ type: z.literal('hide_card'), target: z.literal('daily'), word: miniWordSchema })
      .strict(),
    contextual.extend({ type: z.literal('open_dictation'), word: miniWordSchema }).strict(),
    contextual
      .extend({ type: z.literal('submit_dictation'), dictationId: teachingId, answer: text })
      .strict(),
    contextual.extend({ type: z.literal('reveal_dictation'), dictationId: teachingId }).strict(),
    contextual.extend({ type: z.literal('close_dictation'), dictationId: teachingId }).strict(),
    contextual.extend({ type: z.literal('clear_judgment'), word: miniWordSchema }).strict(),
    contextual.extend({ type: z.literal('unmark_studied'), word: miniWordSchema }).strict(),
    contextual.extend({ type: z.literal('advance_learning_card'), word: miniWordSchema }).strict(),
    z
      .object({
        type: z.literal('memory_advance'),
        target: z.literal('daily'),
        dayId: z.string(),
        word: miniWordSchema,
        round: memoryRound,
        remembered: z.boolean(),
        draft: text.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('memory_reveal'),
        target: z.literal('daily'),
        dayId: z.string(),
        word: miniWordSchema,
        round: memoryRound,
        draft: text.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('memory_draft'),
        target: z.literal('daily'),
        dayId: z.string(),
        word: miniWordSchema,
        round: memoryRound,
        draft: text,
      })
      .strict(),
    z
      .object({
        type: z.literal('window_choose'),
        target: z.literal('daily'),
        dayId: z.string(),
        session: z.enum(['review', 'learning']),
        word: miniWordSchema,
        visitId: teachingId,
        remembered: z.boolean(),
        draft: text.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('window_correct'),
        target: z.literal('daily'),
        dayId: z.string(),
        session: z.enum(['review', 'learning']),
        word: miniWordSchema,
        visitId: teachingId,
      })
      .strict(),
    z
      .object({
        type: z.literal('window_advance'),
        target: z.literal('daily'),
        dayId: z.string(),
        session: z.enum(['review', 'learning']),
        word: miniWordSchema,
        visitId: teachingId,
        remembered: z.boolean().optional(),
        markWrong: z.boolean().optional(),
        draft: text.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('window_familiar'),
        target: z.literal('daily'),
        dayId: z.string(),
        session: z.literal('learning'),
        word: miniWordSchema,
        visitId: teachingId,
        draft: text.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('window_draft'),
        target: z.literal('daily'),
        dayId: z.string(),
        session: z.enum(['review', 'learning']),
        word: miniWordSchema,
        visitId: teachingId,
        draft: text,
      })
      .strict(),
    z
      .object({ type: z.literal('memory_undo'), target: z.literal('daily'), dayId: z.string() })
      .strict(),
    z
      .object({ type: z.literal('begin_probe'), target: z.literal('daily'), word: miniWordSchema })
      .strict(),
    z
      .object({
        type: z.literal('submit_probe'),
        target: z.literal('daily'),
        probeId: teachingId,
        answer: text,
      })
      .strict(),
    z
      .object({ type: z.literal('reveal_probe'), target: z.literal('daily'), probeId: teachingId })
      .strict(),
    z
      .object({ type: z.literal('end_probe'), target: z.literal('daily'), probeId: teachingId })
      .strict(),
    z
      .object({
        type: z.literal('record_probe_help'),
        target: z.literal('daily'),
        probeId: teachingId,
        source: z.enum(['chat', 'audio', 'ui']),
        sourceMessageId: z.string().optional(),
      })
      .strict(),
    contextual.extend({ type: z.literal('pause'), paused: z.boolean() }).strict(),
    contextual
      .extend({
        type: z.literal('choose_judgment'),
        word: miniWordSchema,
        judgment: miniJudgmentSchema,
      })
      .strict(),
    contextual
      .extend({
        type: z.literal('advance_judgment'),
        word: miniWordSchema,
        markWrong: z.boolean().default(false),
      })
      .strict(),
    contextual
      .extend({ type: z.literal('spelling_draft'), word: miniWordSchema, draft: text })
      .strict(),
    contextual
      .extend({
        type: z.literal('submit_spelling'),
        word: miniWordSchema,
        answer: text,
        advanceOnCorrect: z.boolean().default(true),
        advanceAfterCorrect: z.literal(true).optional(),
      })
      .strict(),
    contextual.extend({ type: z.literal('advance_spelling'), word: miniWordSchema }).strict(),
    contextual.extend({ type: z.literal('complete_review') }).strict(),
    contextual
      .extend({
        type: z.literal('mark_studied'),
        word: miniWordSchema,
        remainOnCard: z.boolean().optional(),
      })
      .strict(),
    contextual.extend({ type: z.literal('complete_learning') }).strict(),
    contextual
      .extend({
        type: z.literal('add_sentences'),
        sentences: z.array(miniSentenceSchema).min(1).max(5),
      })
      .strict(),
    contextual
      .extend({
        type: z.literal('translation_draft'),
        taskId: z.string(),
        draft: z.string().max(4000),
      })
      .strict(),
    contextual
      .extend({
        type: z.literal('submit_translation'),
        taskId: z.string(),
        answer: z.string().max(4000),
      })
      .strict(),
    z
      .object({
        type: z.literal('revise_translation'),
        target: z.literal('daily'),
        dayId: z.string(),
        taskId: z.string(),
        attemptId: teachingId,
        answer: z.string().trim().min(1).max(4000),
        aiSelection: miniAiSelectionSchema.optional(),
      })
      .strict(),
    contextual
      .extend({
        type: z.literal('record_feedback'),
        attemptId: z.uuid(),
        feedback: miniFeedbackSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal('publish_writing'),
        target: z.literal('daily'),
        dayId: z.string(),
        prompts: z.array(miniWritingPromptInputSchema).min(1).max(10),
      })
      .strict(),
    qualitativeFeedbackAction,
    contextual
      .extend({
        type: z.literal('advance_translation'),
        taskId: z.string(),
        aiSelection: miniAiSelectionSchema.optional(),
      })
      .strict(),
    contextual.extend({ type: z.literal('continue_to_learning') }).strict(),
  ])
  .superRefine((action, ctx) => {
    if (
      action.type === 'record_exposure' &&
      action.audioKind !== undefined &&
      action.source !== 'audio'
    )
      ctx.addIssue({
        code: 'custom',
        path: ['audioKind'],
        message: 'audioKind requires an audio exposure',
      });
    if (action.type === 'begin' && action.newGroup && action.dayId)
      ctx.addIssue({ code: 'custom', message: 'newGroup cannot resume dayId' });
    if (
      action.type === 'begin' &&
      action.intent !== undefined &&
      (action.target !== 'daily' ||
        action.flowVersion !== 'sliding-window-v2' ||
        action.newGroup ||
        action.overrideRest ||
        (action.intent === 'review' && action.extraGroupForDate !== undefined))
    )
      ctx.addIssue({ code: 'custom', message: 'invalid options for the selected study entry' });
    if (
      action.type === 'begin' &&
      action.extraGroupForDate !== undefined &&
      (action.target !== 'daily' ||
        action.flowVersion !== 'sliding-window-v2' ||
        action.newGroup ||
        action.dayId !== undefined ||
        action.overrideRest ||
        action.recovery)
    )
      ctx.addIssue({ code: 'custom', message: 'extra practice requires the normal daily flow' });
    if (action.target === 'daily' && 'recordId' in action && action.recordId !== undefined)
      ctx.addIssue({ code: 'custom', message: 'recordId is not valid for a daily action' });
    if (action.target === 'review' && 'dayId' in action && action.dayId !== undefined)
      ctx.addIssue({ code: 'custom', message: 'dayId is not valid for a review action' });
    if (
      action.type === 'begin' ||
      action.type === 'set_long_term_plan' ||
      action.type === 'set_today_plan' ||
      action.type === 'clear_today_plan' ||
      action.type === 'set_session_plan' ||
      action.type === 'clear_session_plan' ||
      action.type === 'remember_preference' ||
      action.type === 'forget_preference' ||
      action.type === 'begin_probe' ||
      action.type === 'submit_probe' ||
      action.type === 'reveal_probe' ||
      action.type === 'end_probe' ||
      action.type === 'record_probe_help' ||
      action.type === 'record_card_view' ||
      action.type === 'record_browse_views' ||
      action.type === 'hide_card'
    )
      return;
    if (action.target === 'daily' && !action.dayId)
      ctx.addIssue({ code: 'custom', message: 'dayId is required' });
    if (action.target === 'review' && !action.recordId)
      ctx.addIssue({ code: 'custom', message: 'recordId is required' });
    if (
      action.target === 'daily' &&
      [
        'choose_judgment',
        'advance_judgment',
        'spelling_draft',
        'submit_spelling',
        'advance_spelling',
      ].includes(action.type) &&
      (!('session' in action) || !action.session)
    )
      ctx.addIssue({ code: 'custom', message: 'session is required' });
  });
export type MiniAction = z.infer<typeof miniActionSchema>;
export const miniCommandSchema = z
  .object({
    requestId: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
    occurredAt: timestamp.optional(),
    action: miniActionSchema,
  })
  .strict();
export type MiniCommand = z.infer<typeof miniCommandSchema>;
