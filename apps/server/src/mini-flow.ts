import { randomUUID } from 'node:crypto';
import type {
  MiniAction,
  MiniDay,
  MiniFlow,
  MiniReviewSession,
  MiniWindow,
  MiniWindowEvent,
  MiniWord,
} from '@lingoweave/contracts';
import { LearningError } from './learning-store.js';
import { startSpellingRound } from './mini-spelling.js';

function key(word: MiniWord) {
  return JSON.stringify([word.spelling.trim().toLowerCase(), word.meaning.trim()]);
}
function same(a: MiniWord | undefined, b: MiniWord | undefined) {
  return a !== undefined && b !== undefined && key(a) === key(b);
}
function requireFlow(value: unknown, message = '当前词卡已变化，请刷新后重试。'): asserts value {
  if (!value) throw new LearningError('MINI_STATE_CONFLICT', message);
}
function dateAt(at: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date((at + 978_307_200) * 1000));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export interface MiniFlowOptions {
  dailyNewGoal: number;
  groupSize: number;
  completedToday?: number;
  extraGroupTarget?: number;
}

export function makeMiniWindow(words: MiniWord[], at: number): MiniWindow {
  const window: MiniWindow = {
    version: 'interleaved-v2',
    size: 5,
    gap: 3,
    members: words.slice(0, 5).map((word) => ({ word, stage: 0, admittedAt: at, lastVisit: null })),
    visit: null,
    events: [],
    sequence: 0,
    forceUnseen: false,
  };
  selectMiniWindowVisit(window, at);
  return window;
}

/** The sequence is based on completed visits, never on rendering or audio refreshes. */
export function selectMiniWindowVisit(
  window: MiniWindow,
  at: number,
  preferred?: MiniWord,
  nextId?: string,
) {
  if (window.visit) return;
  const unseen = window.members.find((item) => item.lastVisit === null);
  const eligible = window.members
    .filter((member) => {
      if (member.lastVisit === null) return false;
      const others = new Set(
        window.events
          .filter(
            (event) => event.sequence > (member.lastVisit ?? 0) && !same(event.word, member.word),
          )
          .map((event) => key(event.word)),
      );
      return others.size >= Math.min(window.gap, window.members.length - 1);
    })
    .sort((a, b) => (a.lastVisit ?? 0) - (b.lastVisit ?? 0));
  const member =
    window.members.find((item) => same(item.word, preferred)) ??
    (window.forceUnseen ? unseen : undefined) ??
    eligible[0] ??
    unseen ??
    [...window.members].sort((a, b) => (a.lastVisit ?? 0) - (b.lastVisit ?? 0))[0];
  if (!member) return;
  // One early revisit is allowed before the remaining unseen member gets its turn.
  window.forceUnseen = member.lastVisit !== null && unseen !== undefined;
  window.visit = {
    id: nextId?.toLowerCase() ?? randomUUID(),
    word: member.word,
    stage: member.stage,
    openedAt: at,
    draft: '',
  };
}

export function makeMiniFlowSpelling(words: MiniWord[], seed?: string): MiniReviewSession {
  const session: MiniReviewSession = {
    words: [...words],
    queue: [...words],
    fullBatchSpelling: true,
    spellingPolicy: 'retry-errors-v2',
    spellingSkips: [],
    phase: words.length ? 'spelling' : 'finished',
    judgmentEvents: [],
    spellingAttempts: [],
    spellingState: 'awaitingFirst',
    spellingDraft: '',
  };
  startSpellingRound(session, words, 1, undefined, seed);
  return session;
}

export function makeMiniFlow(
  candidates: MiniWord[],
  options: MiniFlowOptions,
  at: number,
  timezone: string,
): MiniFlow {
  const remaining = Math.max(
    0,
    (options.extraGroupTarget ?? options.dailyNewGoal) - (options.completedToday ?? 0),
  );
  return {
    version: 'sliding-window-v2',
    targetDate: dateAt(at, timezone),
    dailyNewGoal: options.dailyNewGoal,
    ...(options.extraGroupTarget === undefined
      ? {}
      : { extraGroupTarget: options.extraGroupTarget }),
    completedBeforeRun: options.completedToday ?? 0,
    groupSize: options.groupSize,
    candidates: candidates.slice(0, remaining + 5),
    candidateIndex: 0,
    window: makeMiniWindow([], at),
    groupId: randomUUID(),
    groupIndex: 1,
    groupStartedAt: at,
    groupTarget: Math.min(options.groupSize, remaining),
    groupWords: [],
    translationWords: [],
    groups: [],
    completed: [],
    goalReached: remaining === 0,
  };
}

export function miniFlowCompletedToday(flow: MiniFlow, at: number, timezone: string) {
  const date = dateAt(at, timezone);
  return flow.completed.filter((item) => item.date === date).length;
}

function remainingFlow(flow: MiniFlow) {
  return Math.max(
    0,
    (flow.extraGroupTarget ?? flow.dailyNewGoal) -
      flow.completedBeforeRun -
      flow.completed.filter((item) => item.date === flow.targetDate).length,
  );
}

/** Only admitted words become learning targets; reserved material never creates learning facts. */
function fillLearningWindow(day: MiniDay, at: number): MiniWord | undefined {
  const flow = day.flow;
  requireFlow(flow);
  let first: MiniWord | undefined;
  while (
    flow.window.members.length < flow.window.size &&
    flow.candidateIndex < flow.candidates.length
  ) {
    const word = flow.candidates[flow.candidateIndex];
    requireFlow(word);
    flow.candidateIndex += 1;
    if (day.learningWords.some((item) => same(item, word))) continue;
    flow.window.members.push({ word, stage: 0, admittedAt: at, lastVisit: null });
    day.learningWords.push(word);
    first ??= word;
  }
  return first;
}

export function beginMiniFlowLearning(day: MiniDay, at: number) {
  const flow = day.flow;
  requireFlow(flow);
  if (day.writingRequired === false) {
    day.phase = 'finished';
    day.finishedAt = at;
    return;
  }
  day.phase = 'learning';
  day.learningStartedAt ??= at;
  if (flow.goalReached || remainingFlow(flow) === 0) {
    flow.goalReached = true;
    day.paused = true;
    return;
  }
  if (day.learning) return;
  const first = fillLearningWindow(day, at);
  if (flow.window.members.length === 0) {
    if (flow.groupWords.length > 0) freezeMiniFlowGroup(day, at);
    else {
      day.phase = 'finished';
      day.finishedAt = at;
    }
    return;
  }
  selectMiniWindowVisit(flow.window, at, first);
}

export function resumeMiniFlow(
  day: MiniDay,
  options: MiniFlowOptions,
  at: number,
  timezone: string,
  candidates: MiniWord[] = [],
) {
  const flow = day.flow;
  requireFlow(flow);
  const date = dateAt(at, timezone);
  if (day.archivedAt !== undefined || flow.targetDate !== date)
    throw new LearningError('MINI_PLAN_CONFLICT', '已进入新的一天，请开始今天的学习。');
  if (options.extraGroupTarget !== undefined) flow.extraGroupTarget = options.extraGroupTarget;
  flow.dailyNewGoal = options.dailyNewGoal;
  flow.groupSize = options.groupSize;
  flow.completedBeforeRun = Math.max(
    0,
    (options.completedToday ?? 0) - miniFlowCompletedToday(flow, at, timezone),
  );
  flow.goalReached = remainingFlow(flow) === 0;
  const known = new Set(flow.candidates.map(key));
  const needed =
    remainingFlow(flow) +
    5 -
    (flow.candidates.length - flow.candidateIndex) -
    flow.window.members.length -
    flow.groupWords.length;
  for (const word of candidates) {
    if (
      flow.candidates.length -
        flow.candidateIndex +
        flow.window.members.length +
        flow.groupWords.length >=
      remainingFlow(flow) + 5
    )
      break;
    if (needed > 0 && !known.has(key(word)) && !day.reviewWords.some((item) => same(item, word))) {
      flow.candidates.push(word);
      known.add(key(word));
    }
  }
  if (flow.goalReached) {
    if (day.phase !== 'review') day.paused = true;
    return;
  }
  if (day.phase === 'review' || (day.phase === 'learning' && !day.learning)) {
    flow.groupTarget = Math.max(
      flow.groupWords.length,
      flow.extraGroupTarget === undefined
        ? Math.min(flow.groupSize, remainingFlow(flow))
        : remainingFlow(flow),
    );
    if (day.phase === 'review') return;
    if (
      flow.groupWords.length >= flow.groupTarget &&
      flow.groupWords.length > 0 &&
      flow.window.visit?.initial === undefined
    )
      freezeMiniFlowGroup(day, at);
    else beginMiniFlowLearning(day, at);
  }
}

function freezeMiniFlowGroup(day: MiniDay, at: number, seed?: string) {
  const flow = day.flow;
  requireFlow(flow && flow.groupWords.length > 0);
  flow.window.visit = null;
  day.learning = makeMiniFlowSpelling(flow.groupWords, seed);
  for (const word of flow.groupWords) {
    flow.translationWords.push(word);
    day.directions.push(
      flow.translationWords.length % 2 === 1 ? 'englishToChinese' : 'chineseToEnglish',
    );
  }
  day.learningStartedAt ??= at;
}

export function miniPreparationWords(day: MiniDay): MiniWord[] {
  return day.flow ? day.flow.candidates : day.learningWords;
}
export function miniWritingWords(day: MiniDay): MiniWord[] {
  return day.flow ? day.flow.translationWords : [...day.reviewWords, ...day.learningWords];
}
export function currentMiniWindow(day: MiniDay): MiniWindow | undefined {
  if (day.phase === 'review') return day.review?.relearning;
  if (day.phase === 'learning' && !day.learning) return day.flow?.window;
  return undefined;
}

export type MiniWindowAction = Extract<
  MiniAction,
  {
    type:
      'window_choose' | 'window_correct' | 'window_advance' | 'window_familiar' | 'window_draft';
  }
>;

function readyForSpelling(event: MiniWindowEvent) {
  return event.selfReportedFamiliar === true || (event.remembered && event.stage === 2);
}

export function applyMiniWindowAction(
  day: MiniDay,
  action: MiniWindowAction,
  at: number,
  requestId?: string,
) {
  const window = currentMiniWindow(day);
  const visit = window?.visit;
  requireFlow(
    day.flow &&
      !day.paused &&
      window &&
      visit &&
      same(visit.word, action.word) &&
      visit.id === action.visitId &&
      ((day.phase === 'review' && action.session === 'review') ||
        (day.phase === 'learning' && action.session === 'learning')),
  );
  requireFlow(
    action.session === 'review' ||
      day.sentences.some((sentence) => same(sentence.word, visit.word)),
    '请先准备当前词的例句。',
  );
  const familiar = action.type === 'window_familiar';
  if (familiar)
    requireFlow(
      day.phase === 'learning' && visit.stage === 0 && visit.initial === undefined,
      '只能在新词的完整词卡上标记已认识。',
    );
  if ('draft' in action && action.draft !== undefined) visit.draft = action.draft;
  if (action.type === 'window_draft') return;
  if (action.type === 'window_choose') {
    requireFlow(visit.initial === undefined);
    visit.initial = action.remembered;
    visit.selectedAt = at;
    visit.revealedAt = at;
    return;
  }
  if (action.type === 'window_correct') {
    requireFlow(visit.initial === true && visit.correctedAt === undefined);
    visit.correctedAt = at;
    return;
  }
  if (action.type === 'window_advance' && action.markWrong) {
    requireFlow(
      visit.stage > 0 &&
        visit.initial === true &&
        visit.correctedAt === undefined &&
        action.remembered === undefined,
    );
    visit.correctedAt = at;
  }
  const initial = familiar ? true : action.remembered;
  if (visit.stage === 0 && visit.initial === undefined) {
    requireFlow(initial !== undefined);
    visit.initial = initial;
    visit.selectedAt = at;
    visit.revealedAt = at;
  } else requireFlow(initial === undefined, '请在展开后核对，再确认下一词。');
  requireFlow(visit.initial !== undefined && visit.selectedAt !== undefined);
  const remembered = visit.initial && visit.correctedAt === undefined;
  const event: MiniWindowEvent = {
    ...visit,
    ...(familiar ? { selfReportedFamiliar: true } : {}),
    remembered,
    confirmedAt: at,
    sequence: ++window.sequence,
  };
  window.events.push(event);
  const member = window.members.find((item) => same(item.word, visit.word));
  requireFlow(member);
  window.visit = null;
  member.lastVisit = window.sequence;
  const completed = readyForSpelling(event);
  if (completed) window.members = window.members.filter((item) => !same(item.word, visit.word));
  else member.stage = remembered ? member.stage + 1 : 0;
  if (!remembered) window.forceUnseen = true;
  if (action.session === 'review') {
    const session = day.review;
    requireFlow(session);
    const targets = session.relearningWords ?? [];
    const passed = new Set(
      window.events
        .filter((item) => item.stage === 2 && item.remembered)
        .map((item) => key(item.word)),
    );
    let added: MiniWord | undefined;
    for (const word of targets) {
      if (window.members.length >= window.size) break;
      if (passed.has(key(word)) || window.members.some((item) => same(item.word, word))) continue;
      window.members.push({ word, stage: 0, admittedAt: at, lastVisit: null });
      added ??= word;
    }
    if (window.members.length === 0) {
      startSpellingRound(session, session.words, 1, undefined, requestId);
    } else selectMiniWindowVisit(window, at, completed ? added : undefined, requestId);
    return;
  }
  const flow = day.flow;
  if (completed) {
    flow.groupWords.push(visit.word);
    day.studiedWords.push({ word: visit.word, at });
  }
  if (flow.groupWords.length >= flow.groupTarget && flow.groupWords.length > 0) {
    freezeMiniFlowGroup(day, at, requestId);
    return;
  }
  if (completed) {
    const added = fillLearningWindow(day, at);
    if (window.members.length === 0) {
      freezeMiniFlowGroup(day, at, requestId);
      return;
    }
    selectMiniWindowVisit(window, at, added, requestId);
  } else selectMiniWindowVisit(window, at, undefined, requestId);
}

export function finishMiniFlowGroup(day: MiniDay, at: number) {
  const flow = day.flow;
  requireFlow(flow && day.learning?.phase === 'finished');
  flow.groups.push({
    id: flow.groupId,
    index: flow.groupIndex,
    words: [...flow.groupWords],
    startedAt: flow.groupStartedAt,
    finishedAt: at,
    spelling: structuredClone(day.learning),
    translationAttemptIds: day.translation
      .filter((item) => flow.groupWords.some((word) => same(word, item.task.sentence.word)))
      .map((item) => item.id.toLowerCase()),
  });
  flow.groupId = randomUUID();
  flow.groupIndex += 1;
  flow.groupStartedAt = at;
  flow.groupWords = [];
  delete flow.extraGroupTarget;
  flow.groupTarget = Math.min(flow.groupSize, remainingFlow(flow));
  delete day.learning;
  delete day.learningFinishedAt;
  flow.goalReached = remainingFlow(flow) === 0;
  if (flow.goalReached && flow.window.members.length === 0) {
    day.phase = 'finished';
    day.finishedAt = at;
  } else beginMiniFlowLearning(day, at);
}

export function validateMiniWindow(
  window: MiniWindow,
  allowed: MiniWord[],
  session: 'learning' | 'review',
) {
  requireFlow(window.sequence === window.events.length, '窗口访问序号不一致。');
  requireFlow(
    new Set(window.members.map((item) => key(item.word))).size === window.members.length,
    '窗口包含重复单词。',
  );
  const progress = new Map<string, number>();
  const passed = new Set<string>();
  const eventIds = new Set<string>();
  let lastConfirmation: number | undefined;
  for (const [index, event] of window.events.entries()) {
    const identity = key(event.word);
    requireFlow(
      allowed.some((word) => same(word, event.word)) && !passed.has(identity),
      '窗口事件目标无效。',
    );
    requireFlow(
      !eventIds.has(event.id) &&
        event.sequence === index + 1 &&
        event.stage === (progress.get(identity) ?? 0),
      '窗口事件与阶段不一致。',
    );
    eventIds.add(event.id);
    requireFlow(
      event.initial !== undefined &&
        event.selectedAt !== undefined &&
        event.revealedAt !== undefined &&
        event.selectedAt >= event.openedAt &&
        event.revealedAt === event.selectedAt &&
        event.confirmedAt >= event.selectedAt &&
        (lastConfirmation === undefined || event.openedAt >= lastConfirmation) &&
        (event.correctedAt === undefined ||
          (event.initial &&
            event.correctedAt >= event.selectedAt &&
            event.correctedAt <= event.confirmedAt)) &&
        event.remembered === (event.initial && event.correctedAt === undefined),
      '窗口初选或核对事实不完整。',
    );
    if (event.selfReportedFamiliar)
      requireFlow(
        session === 'learning' &&
          event.stage === 0 &&
          event.remembered &&
          event.selectedAt === event.confirmedAt,
        '已认识标记须对应新词完整词卡上的一次明确选择。',
      );
    const next = event.remembered ? event.stage + 1 : 0;
    progress.set(identity, next);
    if (readyForSpelling(event)) passed.add(identity);
    lastConfirmation = event.confirmedAt;
  }
  for (const member of window.members) {
    requireFlow(
      allowed.some((word) => same(word, member.word)) &&
        member.stage === (progress.get(key(member.word)) ?? 0) &&
        !passed.has(key(member.word)),
      '窗口成员阶段缺少事实依据。',
    );
    const last = [...window.events].reverse().find((event) => same(event.word, member.word));
    requireFlow(member.lastVisit === (last?.sequence ?? null), '窗口间隔记录不一致。');
    requireFlow(
      last === undefined || member.admittedAt <= last.openedAt,
      '窗口入场时间晚于实际访问。',
    );
  }
  if (window.visit) {
    const visit = window.visit;
    requireFlow(
      !eventIds.has(visit.id) &&
        window.members.some(
          (member) => same(member.word, visit.word) && member.stage === visit.stage,
        ),
      '当前核对卡与窗口不一致。',
    );
    requireFlow(
      (visit.initial === undefined) === (visit.selectedAt === undefined) &&
        (visit.initial === undefined) === (visit.revealedAt === undefined) &&
        (visit.selectedAt === undefined ||
          (visit.selectedAt >= visit.openedAt && visit.revealedAt === visit.selectedAt)) &&
        (lastConfirmation === undefined || visit.openedAt >= lastConfirmation) &&
        (visit.correctedAt === undefined ||
          (visit.initial === true &&
            visit.selectedAt !== undefined &&
            visit.correctedAt >= visit.selectedAt)),
      '当前核对记录不完整。',
    );
  }
}

export function validateMiniFlowDay(
  day: MiniDay,
  validSession: (session: MiniReviewSession) => void,
) {
  const flow = day.flow;
  requireFlow(flow && day.memory === undefined, '新版流程不能同时启用旧记忆轮次。');
  requireFlow(
    flow.candidateIndex <= flow.candidates.length &&
      new Set(flow.candidates.map(key)).size === flow.candidates.length,
    '候选池进度无效。',
  );
  validateMiniWindow(flow.window, day.learningWords, 'learning');
  const passed = flow.window.events.filter(readyForSpelling);
  const allGroups = [...flow.groups.flatMap((group) => group.words), ...flow.groupWords];
  const passedKeys = new Set(passed.map((event) => key(event.word)));
  requireFlow(
    JSON.stringify(flow.window.members.map((item) => key(item.word))) ===
      JSON.stringify(day.learningWords.filter((word) => !passedKeys.has(key(word))).map(key)),
    '窗口不能丢弃尚未通过的词。',
  );
  requireFlow(
    JSON.stringify(passed.map((event) => key(event.word))) === JSON.stringify(allGroups.map(key)),
    '记忆通过集合与实际事件不一致。',
  );
  requireFlow(
    JSON.stringify(day.studiedWords) ===
      JSON.stringify(passed.map((event) => ({ word: event.word, at: event.confirmedAt }))),
    '新词记住记录与核对事实不一致。',
  );
  requireFlow(
    day.learningWords.length === flow.candidateIndex &&
      day.learningWords.every((word, index) => same(word, flow.candidates[index])),
    '入窗目标与候选游标不一致。',
  );
  requireFlow(
    new Set(flow.completed.map((item) => key(item.word))).size === flow.completed.length &&
      new Set(flow.completed.map((item) => item.attemptId)).size === flow.completed.length,
    '完成事实重复。',
  );
  for (const completion of flow.completed) {
    const attempt = day.translation.find((item) => item.id.toLowerCase() === completion.attemptId);
    requireFlow(
      attempt &&
        same(attempt.task.sentence.word, completion.word) &&
        attempt.confirmedAt === completion.at &&
        dateAt(completion.at, day.timezone ?? 'UTC') === completion.date,
      '完成事件缺少对应翻译确认。',
    );
  }
  requireFlow(
    flow.completed.length ===
      day.translation.filter((attempt) => attempt.confirmedAt !== undefined).length,
    '翻译确认与完成数不一致。',
  );
  for (const group of flow.groups) {
    requireFlow(
      group.spelling.phase === 'finished' &&
        group.words.every((word) => flow.completed.some((item) => same(item.word, word))),
      '历史组未完成。',
    );
    requireFlow(
      JSON.stringify(group.words) === JSON.stringify(group.spelling.words),
      '历史拼写目标不一致。',
    );
    validSession(group.spelling);
    requireFlow(
      group.translationAttemptIds.length === group.words.length &&
        group.translationAttemptIds.every((id) =>
          day.translation.some(
            (attempt) =>
              attempt.id.toLowerCase() === id &&
              group.words.some((word) => same(word, attempt.task.sentence.word)),
          ),
        ),
      '历史组翻译引用无效。',
    );
  }
  if (day.learning) {
    requireFlow(
      JSON.stringify(day.learning.words) === JSON.stringify(flow.groupWords),
      '当前拼写组目标不一致。',
    );
    validSession(day.learning);
  }
  const frozenWords = [
    ...flow.groups.flatMap((group) => group.words),
    ...(day.learning ? flow.groupWords : []),
  ];
  requireFlow(
    JSON.stringify(flow.translationWords) === JSON.stringify(frozenWords),
    '翻译目标不能包含储备或未通过词。',
  );
  requireFlow(
    day.directions.length === flow.translationWords.length &&
      day.translationIndex <= flow.translationWords.length &&
      day.translation.length <= day.translationIndex + 1,
    '新版翻译进度不一致。',
  );
  for (const [index, attempt] of day.translation.entries()) {
    requireFlow(
      attempt.task.id === `${day.id}/${index}` &&
        same(attempt.task.sentence.word, flow.translationWords[index]) &&
        attempt.task.direction === day.directions[index] &&
        attempt.answer.trim().length > 0,
      '新版翻译题目或原答无效。',
    );
    requireFlow(
      index < day.translationIndex === (attempt.confirmedAt !== undefined) &&
        (attempt.feedback === undefined) === (attempt.gradedAt === undefined),
      '新版翻译确认或反馈无效。',
    );
    requireFlow(
      day.writingPrompts?.some(
        (prompt) =>
          prompt.id === attempt.task.materialId &&
          same(prompt.sentence.word, attempt.task.sentence.word) &&
          prompt.sentence.english === attempt.task.sentence.english &&
          prompt.sentence.chinese === attempt.task.sentence.chinese,
      ),
      '翻译原答没有固定题目。',
    );
  }
  requireFlow(
    day.reviewWords.length === (day.review?.words.length ?? 0) &&
      day.reviewSteps.length === day.reviewWords.length,
    '复习目标不一致。',
  );
  if (day.review) validSession(day.review);
  if (day.phase !== 'review' && day.review)
    requireFlow(
      day.review.phase === 'finished' && day.reviewFinishedAt !== undefined,
      '复习未结束不能开始新词。',
    );
  if (day.phase === 'translation')
    requireFlow(
      day.learning?.phase === 'finished' && day.translationIndex < flow.translationWords.length,
      '拼写未结束不能翻译。',
    );
  requireFlow(
    day.sentences.every((sentence) =>
      [...day.reviewWords, ...flow.candidates].some((word) => same(word, sentence.word)),
    ) && new Set(day.sentences.map((item) => key(item.word))).size === day.sentences.length,
    '备课材料目标不合法。',
  );
}
