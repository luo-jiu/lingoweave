import type { MiniExpressionGrade, MiniTranslationTask } from '@lingoweave/contracts';
import { LearningError } from './learning-store.js';

export const translationRubric =
  '英译中评的是英语理解：原句的关键信息和交际意图都表达出来就给 natural（翻译正确），包括不同语序、口语、亲友间自然的称呼。只有实质错译或漏译才给 off_meaning（偏离原意），说明究竟改变了什么。不得给 understandable。标点、语气词和书面风格不影响意思时不提修改，不必模仿参考译文。若标点确实改变否定、数字、对象或问句含义则按实际意义判断。中译英仍按 natural、understandable、off_meaning 三档评表达。';

export function validateTranslationGrade(
  direction: MiniTranslationTask['direction'],
  grade: MiniExpressionGrade,
  improvements: readonly string[] = [],
) {
  if (direction !== 'englishToChinese') return;
  if (grade === 'understandable' || (grade === 'natural' && improvements.length))
    throw new LearningError(
      'TRANSLATION_MEANING_RUBRIC',
      '英译中按整句意思给 natural 或 off_meaning。理解正确时 improvements 留空，真正偏义时解释具体的信息差异。',
      400,
    );
}

// These variants express the same written greeting and preserve the following clause boundary.
// Keep interior punctuation elsewhere: “不，要走” and “不要走” can mean opposite things.
function conventionalGreeting(text: string) {
  return text
    .trim()
    .normalize('NFC')
    .replace(
      /^(再见|拜拜|早上好|晚安)[，,]?(爸爸?|妈妈?)[！!。，,](?=\s*\p{Script=Han})/u,
      '$1$2，',
    )
    .replace(/[。！!]$/u, '');
}

export function matchesChineseReferences(answer: string, original: string, assessed: string) {
  const wording = conventionalGreeting(answer);
  return (
    wording.length > 0 &&
    wording === conventionalGreeting(original) &&
    wording === conventionalGreeting(assessed)
  );
}
