import type {
  MiniAssessmentJob,
  MiniAssessmentResult,
  MiniDay,
  MiniTranslationReview,
  MiniTranslationReviewQuery,
} from '@lingoweave/contracts';
import { matchesChineseReferences } from './mini-translation-rubric.js';
import { unixDate } from './mini-study.js';

type Entry = MiniTranslationReview['entries'][number];
export type TranslationAssessment = {
  status: MiniAssessmentJob['status'];
  result: MiniAssessmentResult | null;
};

function nonempty(values: string[]) {
  return [...new Set(values.filter((text) => text.trim().length > 0))];
}

function review(
  attempt: MiniDay['translation'][number],
  versionId: string,
  assessment: TranslationAssessment | null,
): Pick<Entry, 'status' | 'commentary' | 'retryJobId' | 'expressionGrade'> {
  const result = assessment?.result;
  const { direction, sentence } = attempt.task;
  const originalReference = direction === 'englishToChinese' ? sentence.chinese : sentence.english;
  if (result) {
    return {
      ...(result.expressionGrade && { expressionGrade: result.expressionGrade }),
      status: 'ready',
      retryJobId: null,
      commentary: {
        summary: result.summary,
        strengths: nonempty(result.strengths),
        improvements: nonempty(result.improvements),
        keyPoints: result.reusablePhrase
          ? [result.reusablePhrase.expression + ' · ' + result.reusablePhrase.explanation]
          : [],
        referenceTranslation: result.referenceTranslation.trim() || originalReference,
      },
    };
  }
  const old = versionId === attempt.id.toLowerCase() ? attempt.feedback : undefined;
  if (old) {
    return {
      ...(old.expressionGrade && { expressionGrade: old.expressionGrade }),
      status: 'ready',
      retryJobId: null,
      commentary: {
        summary: old.comment,
        strengths: nonempty(old.strengths ?? []),
        improvements: nonempty([...(old.improvements ?? []), old.tip]),
        keyPoints: nonempty([...(old.keyPoints ?? []), old.usefulPhrase]),
        referenceTranslation: old.referenceTranslation?.trim() || originalReference,
      },
    };
  }
  const status = assessment?.status;
  return {
    status:
      status === 'failed' || status === 'running' || status === 'queued' ? status : 'submitted',
    commentary: null,
    retryJobId: status === 'failed' ? versionId : null,
  };
}

export function needsMeaningReview(entry: Entry) {
  return (
    entry.direction === 'englishToChinese' &&
    entry.status === 'ready' &&
    (!entry.expressionGrade || entry.expressionGrade === 'understandable')
  );
}

export function pendingMeaningComment(entry: Entry): Entry {
  if (!needsMeaningReview(entry)) return entry;
  const pending = { ...entry, commentary: null };
  delete pending.expressionGrade;
  return pending;
}

export function translationReview(
  days: ReadonlyArray<Pick<MiniDay, 'id' | 'translation'>>,
  query: MiniTranslationReviewQuery,
  findAssessment: (attemptId: string) => TranslationAssessment | null,
): MiniTranslationReview {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: query.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const entries: Entry[] = [];
  for (const day of days) {
    for (const attempt of day.translation) {
      if (formatter.format(unixDate(attempt.submittedAt)) !== query.date) continue;
      const { direction, sentence } = attempt.task;
      const id = attempt.id.toLowerCase();
      const revision = attempt.revisions?.at(-1);
      const versionId = revision?.id.toLowerCase() ?? id;
      const assessment =
        attempt.confirmedAt !== undefined || revision ? findAssessment(versionId) : null;
      const entry: Entry = {
        attemptId: id,
        ...(revision && { answerRevisionId: versionId }),
        dayId: day.id,
        word: sentence.word,
        direction,
        submittedAt: attempt.submittedAt,
        question: direction === 'englishToChinese' ? sentence.english : sentence.chinese,
        answer: revision?.answer ?? attempt.answer,
        ...review(attempt, versionId, assessment),
      };
      if (direction === 'englishToChinese' && entry.commentary) {
        const { commentary, expressionGrade } = entry;
        if (expressionGrade === 'understandable' || !expressionGrade) {
          // Use the independent exercise and assessment references. Keep ordinary clause
          // boundaries intact; different wording is left for a semantic review on request.
          const reviewedReference = assessment?.result
            ? assessment.result.referenceTranslation
            : versionId === id
              ? attempt.feedback?.referenceTranslation
              : undefined;
          if (
            reviewedReference &&
            matchesChineseReferences(entry.answer, sentence.chinese, reviewedReference)
          ) {
            entry.expressionGrade = 'natural';
            entry.commentary = {
              ...commentary,
              summary: '你的译文准确传达了原句的意思。',
              strengths: [],
              improvements: [],
            };
          }
        } else if (expressionGrade === 'natural' && commentary.improvements.length > 0) {
          entry.commentary = {
            ...commentary,
            summary: '你的译文准确传达了原句的意思。',
            improvements: [],
          };
        }
      }
      entries.push(entry);
    }
  }
  entries.sort((a, b) => b.submittedAt - a.submittedAt || a.attemptId.localeCompare(b.attemptId));
  return { ...query, entries };
}
