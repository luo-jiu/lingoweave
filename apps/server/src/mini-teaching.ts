import { createHash, randomUUID } from 'node:crypto';
import {
  miniAIContextInputSchema,
  miniAIContextSchema,
  miniHistoryInputSchema,
  miniHistoryPageSchema,
  miniWordContextInputSchema,
  miniWordContextSchema,
  type MiniAction,
  type MiniAIContextInput,
  type MiniDay,
  type MiniHistoryInput,
  type MiniHistoryItem,
  type MiniHistoryPage,
  type MiniReviewSession,
  type MiniSnapshot,
  type MiniWord,
  type MiniWordContextInput,
} from '@lingoweave/contracts';
import { LearningError } from './learning-store.js';
import {
  currentLearningWord,
  currentMiniWindow,
  currentTranslation,
  localDay,
  miniPreparationWords,
  sameWord,
  wordKey,
} from './mini-study.js';

export function miniSenseId(word: MiniWord): string {
  return `sense-${createHash('sha256').update(wordKey(word)).digest('hex')}`;
}
function conflict(message: string): never {
  throw new LearningError('MINI_TEACHING_CONFLICT', message);
}
function requireFact(condition: boolean, message: string): asserts condition {
  if (!condition) conflict(message);
}
function dayWords(day: MiniDay) {
  return [...day.reviewWords, ...day.learningWords];
}
function teachingWords(day: MiniDay) {
  return [...day.reviewWords, ...miniPreparationWords(day)];
}
function focusForWord(state: MiniSnapshot, word: MiniWord) {
  return state.teaching.focusItems.filter((focus) => focus.senseIds.includes(miniSenseId(word)));
}
function knownWord(state: MiniSnapshot, word: MiniWord) {
  const sense = miniSenseId(word);
  return (
    state.scheduling.cards.some((card) => card.senseId === sense) ||
    state.scheduling.views.some((item) => miniSenseId(item.word) === sense) ||
    state.scheduling.flow.cards.some((card) => miniSenseId(card.word) === sense) ||
    state.ledger.days.some((day) =>
      teachingWords(day).some((item) => miniSenseId(item) === sense),
    ) ||
    [state.reviewRecord, ...state.reviewHistory].some((record) =>
      record?.session.words.some((item) => miniSenseId(item) === sense),
    )
  );
}
function requireFocusLinks(state: MiniSnapshot, ids: string[], word: MiniWord) {
  requireFact(new Set(ids).size === ids.length, '重点引用不能重复。');
  requireFact(
    ids.every((id) =>
      focusForWord(state, word).some((focus) => focus.id === id && focus.status === 'active'),
    ),
    '重点必须关联当前词义且处于使用中。',
  );
}
/** Returns true when this module handled the command. */
export function applyMiniTeachingAction(
  state: MiniSnapshot,
  action: MiniAction,
  at: number,
): boolean {
  if (action.type === 'remember_preference') {
    const memory = state.teaching.memories.find((item) => item.key === action.key);
    if (memory) {
      memory.value = action.value;
      memory.sourceMessageId = action.sourceMessageId;
      memory.updatedAt = at;
    } else {
      requireFact(
        state.teaching.memories.length < 20,
        '稳定偏好最多保存 20 条，请先修改或删除旧偏好。',
      );
      state.teaching.memories.push({
        id: randomUUID(),
        key: action.key,
        value: action.value,
        sourceMessageId: action.sourceMessageId,
        createdAt: at,
        updatedAt: at,
      });
    }
    return true;
  }
  if (action.type === 'forget_preference') {
    const index = state.teaching.memories.findIndex((item) => item.id === action.memoryId);
    requireFact(index >= 0, '要删除的偏好不存在。');
    state.teaching.memories.splice(index, 1);
    return true;
  }
  if (action.type === 'create_focus') {
    const day = state.ledger.days.find((item) => item.id === action.dayId);
    requireFact(!!day, '重点来源学习组不存在。');
    requireFact(day.writingRequired !== false, '仅复习组不能扩展新重点。');
    const senseIds = action.words.map(miniSenseId);
    requireFact(new Set(senseIds).size === senseIds.length, '重点关联词义不能重复。');
    requireFact(
      action.words.every((word) => teachingWords(day).some((item) => sameWord(item, word))),
      '重点必须关联来源学习组的真实词义。',
    );
    requireFact(
      !action.sourceAttemptId ||
        day.translation.some(
          (item) => item.id.toLowerCase() === action.sourceAttemptId?.toLowerCase(),
        ),
      '重点来源原答不存在。',
    );
    requireFact(
      state.teaching.focusItems.filter((focus) => focus.source.dayId === day.id).length < 1,
      '本组最多新增一个重点，优先复练已有重点。',
    );
    const normalized = action.expression.trim().replace(/\s+/g, ' ').toLowerCase();
    requireFact(
      !state.teaching.focusItems.some(
        (focus) =>
          focus.expression.trim().replace(/\s+/g, ' ').toLowerCase() === normalized &&
          focus.senseIds.some((id) => senseIds.includes(id)),
      ),
      '这个词义已经保存过相同重点，请复用或恢复原重点。',
    );
    requireFact(
      action.words.every(
        (word) => focusForWord(state, word).filter((item) => item.status === 'active').length < 2,
      ),
      '每个词义最多使用两个重点。',
    );
    state.teaching.focusItems.push({
      id: randomUUID(),
      senseIds,
      words: action.words,
      expression: action.expression,
      explanation: action.explanation,
      status: 'active',
      source: {
        dayId: day.id,
        ...(action.sourceAttemptId
          ? {
              attemptId: day.translation.find(
                (item) => item.id.toLowerCase() === action.sourceAttemptId?.toLowerCase(),
              )?.id,
            }
          : {}),
      },
      reason: action.reason,
      createdAt: at,
      updatedAt: at,
      changes: [{ status: 'active', explanation: action.explanation, reason: action.reason, at }],
    });
    return true;
  }
  if (action.type === 'update_focus') {
    const day = state.ledger.days.find((item) => item.id === action.dayId);
    const focus = state.teaching.focusItems.find((item) => item.id === action.focusId);
    requireFact(
      !!day &&
        !!focus &&
        teachingWords(day).some((word) => focus.senseIds.includes(miniSenseId(word))),
      '重点与当前学习组不匹配。',
    );
    if (action.status === 'active' && focus.status !== 'active')
      requireFact(
        focus.words.every(
          (word) => focusForWord(state, word).filter((item) => item.status === 'active').length < 2,
        ),
        '每个词义最多使用两个重点。',
      );
    focus.status = action.status;
    focus.explanation = action.explanation ?? focus.explanation;
    focus.reason = action.reason;
    focus.updatedAt = at;
    focus.changes.push({
      status: focus.status,
      explanation: focus.explanation,
      reason: action.reason,
      at,
    });
    return true;
  }
  if (action.type === 'record_exposure') {
    requireFact(
      action.audioKind === undefined || action.source === 'audio',
      '音频类型只能附在真实音频曝光上。',
    );
    let session = action.session;
    let beforeAttemptCount: number;
    let beforeJudgmentCount: number | undefined;
    if (action.target === 'daily') {
      const day = state.ledger.days.find((item) => item.id === action.dayId);
      requireFact(
        !!day && day.id === state.planning.activeDayId && day.phase !== 'finished',
        '帮助只能记录到当前未完成的学习组。',
      );
      const expected =
        day.phase === 'review'
          ? (currentMiniWindow(day)?.visit?.word ?? day.review?.queue[0])
          : day.phase === 'learning'
            ? currentLearningWord(day)
            : currentTranslation(day)?.sentence.word;
      requireFact(sameWord(expected, action.word), '帮助目标已变化，不能写到另一张词卡。');
      const expectedSession = day.phase === 'translation' ? undefined : day.phase;
      requireFact(
        session === undefined || session === expectedSession,
        '帮助对应的学习阶段已变化。',
      );
      session = expectedSession;
      if (expectedSession === 'review') beforeJudgmentCount = day.review?.judgmentEvents.length;
      beforeAttemptCount =
        expectedSession === 'review'
          ? (day.review?.spellingAttempts.length ?? 0)
          : expectedSession === 'learning'
            ? (day.learning?.spellingAttempts.length ?? 0)
            : 0;
    } else {
      const record = state.reviewRecord;
      requireFact(
        !!record &&
          record.id.toLowerCase() === action.recordId?.toLowerCase() &&
          sameWord(record.session.queue[0], action.word),
        '帮助必须关联当前复习词卡。',
      );
      requireFact(session === undefined || session === 'review', '帮助对应的复习阶段不匹配。');
      session = 'review';
      beforeAttemptCount = record.session.spellingAttempts.length;
      beforeJudgmentCount = record.session.judgmentEvents.length;
    }
    requireFocusLinks(state, action.focusIds, action.word);
    state.teaching.exposures.push({
      id: randomUUID(),
      target: action.target,
      ...(action.target === 'daily'
        ? { dayId: action.dayId }
        : { recordId: state.reviewRecord?.id }),
      ...(session ? { session } : {}),
      word: action.word,
      kind: action.kind,
      source: action.source,
      ...(action.audioKind ? { audioKind: action.audioKind } : {}),
      focusIds: action.focusIds,
      ...(action.sourceMessageId ? { sourceMessageId: action.sourceMessageId } : {}),
      beforeAttemptCount,
      ...(beforeJudgmentCount === undefined ? {} : { beforeJudgmentCount }),
      at,
    });
    return true;
  }
  return false;
}

export function validateMiniTeaching(state: MiniSnapshot) {
  const focusIds = new Set<string>();
  const sourceCounts = new Map<string, number>();
  const active = new Map<string, number>();
  for (const focus of state.teaching.focusItems) {
    requireFact(!focusIds.has(focus.id), '重点身份重复。');
    focusIds.add(focus.id);
    const day = state.ledger.days.find((item) => item.id === focus.source.dayId);
    requireFact(
      !!day &&
        focus.words.length === focus.senseIds.length &&
        focus.words.every(
          (word, index) =>
            focus.senseIds[index] === miniSenseId(word) &&
            teachingWords(day).some((item) => sameWord(item, word)),
        ),
      '重点缺少有效的词义或来源。',
    );
    requireFact(
      !focus.source.attemptId || day.translation.some((item) => item.id === focus.source.attemptId),
      '重点缺少来源原答。',
    );
    sourceCounts.set(day.id, (sourceCounts.get(day.id) ?? 0) + 1);
    requireFact((sourceCounts.get(day.id) ?? 0) <= 1, '同组新增重点超过预算。');
    const latest = focus.changes.at(-1);
    requireFact(
      !!latest &&
        latest.status === focus.status &&
        latest.explanation === focus.explanation &&
        latest.reason === focus.reason &&
        latest.at === focus.updatedAt &&
        focus.createdAt === focus.changes[0]?.at,
      '重点版本记录不一致。',
    );
    for (const senseId of focus.senseIds) {
      if (focus.status === 'active') active.set(senseId, (active.get(senseId) ?? 0) + 1);
      requireFact((active.get(senseId) ?? 0) <= 2, '词义使用中的重点超过预算。');
    }
  }
  requireFact(
    new Set(state.teaching.memories.map((item) => item.id)).size ===
      state.teaching.memories.length &&
      new Set(state.teaching.memories.map((item) => item.key)).size ===
        state.teaching.memories.length,
    '偏好身份或名称重复。',
  );
  const exposureIds = new Set<string>();
  for (const item of state.teaching.exposures) {
    requireFact(
      item.audioKind === undefined || item.source === 'audio',
      '音频类型与曝光来源不一致。',
    );
    requireFact(!exposureIds.has(item.id), '曝光身份重复。');
    exposureIds.add(item.id);
    const words =
      item.target === 'daily'
        ? state.ledger.days.find((day) => day.id === item.dayId)
        : [state.reviewRecord, ...state.reviewHistory].find(
            (record) => record?.id === item.recordId,
          );
    requireFact(
      !!words &&
        ('reviewWords' in words ? dayWords(words) : words.session.words).some((word) =>
          sameWord(word, item.word),
        ),
      '曝光记录缺少真实目标。',
    );
    requireFact(
      item.focusIds.every((id) =>
        state.teaching.focusItems.some(
          (focus) => focus.id === id && focus.senseIds.includes(miniSenseId(item.word)),
        ),
      ),
      '曝光关联重点不存在。',
    );
  }
  const checkHelp = (
    session: MiniReviewSession | undefined,
    identity: { dayId: string; session: 'review' | 'learning' } | { recordId: string },
  ) => {
    if (!session) return;
    for (const [index, attempt] of session.spellingAttempts.entries()) {
      const helpful = state.teaching.exposures.filter(
        (item) =>
          item.beforeAttemptCount <= index &&
          item.at <= attempt.submittedAt &&
          sameWord(item.word, attempt.word) &&
          ('dayId' in identity
            ? item.dayId === identity.dayId && item.session === identity.session
            : item.recordId === identity.recordId),
      );
      const latest = helpful.reduce<number | undefined>(
        (value, item) => (value === undefined ? item.at : Math.max(value, item.at)),
        undefined,
      );
      requireFact(
        attempt.lastPotentialHelpAt === latest,
        '拼写帮助条件必须对应已保存且早于本次原答的真实曝光。',
      );
    }
  };
  for (const day of state.ledger.days) {
    checkHelp(day.review, { dayId: day.id, session: 'review' });
    checkHelp(day.learning, { dayId: day.id, session: 'learning' });
    for (const group of day.flow?.groups ?? [])
      checkHelp(group.spelling, { dayId: day.id, session: 'learning' });
  }
  for (const record of [state.reviewRecord, ...state.reviewHistory])
    if (record) checkHelp(record.session, { recordId: record.id });
}

export function validateMiniWritingLinks(state: MiniSnapshot, ids: string[], word: MiniWord) {
  requireFocusLinks(state, ids, word);
}

export function miniFactHistory(state: MiniSnapshot): MiniHistoryItem[] {
  const items: MiniHistoryItem[] = [];
  const addSession = (
    session: MiniReviewSession | undefined,
    identity: { dayId: string; session: 'review' | 'learning' } | { recordId: string },
    groupId?: string,
  ) => {
    if (!session) return;
    const prefix =
      'dayId' in identity
        ? `day/${identity.dayId}/${groupId ? `group/${groupId}/` : ''}${identity.session}`
        : `review/${identity.recordId}`;
    session.judgmentEvents.forEach((item, index) =>
      items.push({
        id: `${prefix}/judgment/${index}`,
        kind: 'judgment',
        at: item.finalizedAt ?? item.selectedAt,
        ...identity,
        word: item.word,
        data: { ...item, ...(groupId ? { groupId } : {}) },
      }),
    );
    session.spellingAttempts.forEach((item, index) =>
      items.push({
        id: `${prefix}/spelling/${index}`,
        kind: 'spelling',
        at: item.submittedAt,
        ...identity,
        word: item.word,
        data: { ...item, ...(groupId ? { groupId } : {}) },
      }),
    );
    session.spellingSkips?.forEach((item, index) =>
      items.push({
        id: `${prefix}/skip/${index}`,
        kind: 'spelling_skip',
        at: item.at,
        ...identity,
        word: item.word,
        data: {
          ...item,
          ...(groupId ? { groupId } : {}),
          evidence:
            item.round === 3
              ? 'skipped_after_three_failed_first_answers'
              : 'skipped_after_five_failed_first_answers',
          mastered: false,
        },
      }),
    );
  };
  for (const day of state.ledger.days) {
    addSession(day.review, { dayId: day.id, session: 'review' });
    addSession(day.learning, { dayId: day.id, session: 'learning' }, day.flow?.groupId);
    for (const group of day.flow?.groups ?? [])
      addSession(group.spelling, { dayId: day.id, session: 'learning' }, group.id);
    for (const [session, window] of [
      ['learning', day.flow?.window],
      ['review', day.review?.relearning],
    ] as const)
      window?.events.forEach((item) =>
        items.push({
          id: `day/${day.id}/${session}/window/${item.id}`,
          kind: 'memory',
          at: item.confirmedAt,
          dayId: day.id,
          session,
          word: item.word,
          data: {
            ...item,
            evidence: 'interleaved_memory',
            mastered: false,
            ...(session === 'review' &&
            item.stage === 1 &&
            !day.sentences.some((sentence) => sameWord(sentence.word, item.word))
              ? { missingSentence: true, supportedByMeaning: true }
              : {}),
          },
        }),
      );
    day.memory?.events.forEach((item) =>
      items.push({
        id: `day/${day.id}/memory/${item.id}`,
        kind: 'memory',
        at: item.at,
        dayId: day.id,
        word: item.word,
        data: { ...item, evidence: 'memory_round', mastered: false },
      }),
    );
    day.studiedWords.forEach((item, index) =>
      items.push({
        id: `day/${day.id}/view/${index}`,
        kind: 'view',
        at: item.at,
        dayId: day.id,
        word: item.word,
        data: { ...item, evidence: 'marked_studied' },
      }),
    );
    day.sentences.forEach((item, index) =>
      items.push({
        id: `day/${day.id}/sentence/${index}`,
        kind: 'material',
        at: day.startedAt,
        dayId: day.id,
        word: item.word,
        data: { ...item, exactPublishedAtRecorded: false, materialKind: 'learning' },
      }),
    );
    day.writingPrompts?.forEach((item) =>
      items.push({
        id: `day/${day.id}/writing/${item.id}`,
        kind: 'material',
        at: item.createdAt,
        dayId: day.id,
        word: item.sentence.word,
        data: { ...item, materialKind: 'writing' },
      }),
    );
    day.translation.forEach((item) => {
      items.push({
        id: `day/${day.id}/translation/${item.id}`,
        kind: 'translation',
        at: item.submittedAt,
        dayId: day.id,
        word: item.task.sentence.word,
        data: {
          id: item.id,
          task: item.task,
          answer: item.answer,
          submittedAt: item.submittedAt,
          ...(item.confirmedAt === undefined ? {} : { confirmedAt: item.confirmedAt }),
        },
      });
      if (item.feedback && item.gradedAt !== undefined)
        items.push({
          id: `day/${day.id}/feedback/${item.id}`,
          kind: 'feedback',
          at: item.gradedAt,
          dayId: day.id,
          word: item.task.sentence.word,
          data: { attemptId: item.id, feedback: item.feedback },
        });
    });
  }
  const records = new Map(state.reviewHistory.map((record) => [record.id, record]));
  if (state.reviewRecord) records.set(state.reviewRecord.id, state.reviewRecord);
  for (const record of records.values()) addSession(record.session, { recordId: record.id });
  for (const item of state.teaching.exposures)
    items.push({
      id: `exposure/${item.id}`,
      kind: 'exposure',
      at: item.at,
      ...(item.dayId ? { dayId: item.dayId } : {}),
      ...(item.recordId ? { recordId: item.recordId } : {}),
      ...(item.session ? { session: item.session } : {}),
      word: item.word,
      data: { ...item },
    });
  for (const probe of state.scheduling.probes)
    if (probe.submittedAt !== undefined)
      items.push({
        id: `probe/${probe.id}`,
        kind: 'probe',
        at: probe.submittedAt,
        word: probe.word,
        data: { ...probe },
      });
  for (const dictation of state.practice.dictations) {
    for (const attempt of dictation.attempts)
      items.push({
        id: `dictation/${dictation.id}/${attempt.id}`,
        kind: 'dictation',
        at: attempt.submittedAt,
        word: dictation.word,
        ...(dictation.dayId ? { dayId: dictation.dayId } : {}),
        ...(dictation.recordId ? { recordId: dictation.recordId } : {}),
        data: { ...attempt, evidence: 'supported_practice', dictationId: dictation.id },
      });
  }
  for (const view of state.scheduling.views)
    items.push({
      id: `card-view/${view.id}`,
      kind: 'view',
      at: view.at,
      word: view.word,
      data: { ...view, evidence: 'visible_english' },
    });
  return items;
}

export function miniHistoryPage(
  state: MiniSnapshot,
  raw: MiniHistoryInput,
  planEvents: MiniHistoryItem[] = [],
): MiniHistoryPage {
  const input = miniHistoryInputSchema.parse(raw);
  const filter = createHash('sha256')
    .update(
      JSON.stringify({
        kind: input.kind,
        dayId: input.dayId,
        word: input.word ? miniSenseId(input.word) : undefined,
      }),
    )
    .digest('hex');
  if (input.cursor && (input.cursor.revision !== state.revision || input.cursor.filter !== filter))
    throw new LearningError(
      'MINI_HISTORY_CURSOR_STALE',
      '历史记录或查询条件已变化，请从第一页重新查询。',
    );
  const items = [...miniFactHistory(state), ...planEvents]
    .filter(
      (item) =>
        (input.kind === 'all' || item.kind === input.kind) &&
        (!input.dayId || item.dayId === input.dayId) &&
        (!input.word || (item.word && miniSenseId(item.word) === miniSenseId(input.word))),
    )
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  const offset = input.cursor?.offset ?? 0;
  const next = offset + input.limit;
  return miniHistoryPageSchema.parse({
    revision: state.revision,
    items: items.slice(offset, next),
    nextCursor: next < items.length ? { revision: state.revision, offset: next, filter } : null,
  });
}

export function miniAIContext(state: MiniSnapshot, raw: MiniAIContextInput, at: number) {
  const input = miniAIContextInputSchema.parse(raw);
  const dayId = input.dayId ?? state.planning.activeDayId;
  const day = state.ledger.days.find((item) => item.id === dayId) ?? null;
  requireFact(!input.dayId || !!day, '要查询的学习组不存在。');
  const actual = miniFactHistory(state).filter((item) =>
    [
      'judgment',
      'view',
      'spelling',
      'translation',
      'probe',
      'dictation',
      'memory',
      'spelling_skip',
    ].includes(item.kind),
  );
  const days = new Set(
    actual.map((item) => localDay(new Date((item.at + 978_307_200) * 1000), input.timezone)),
  );
  const targets = day ? teachingWords(day).map(miniSenseId) : [];
  const visit = day ? currentMiniWindow(day)?.visit : undefined;
  return miniAIContextSchema.parse({
    revision: state.revision,
    date: localDay(new Date((at + 978_307_200) * 1000), input.timezone),
    timezone: input.timezone,
    planning: state.planning,
    day,
    currentTask: day ? (currentTranslation(day) ?? null) : null,
    ...(visit
      ? {
          currentLearning: {
            word: visit.word,
            stage: visit.stage === 0 ? 'initial' : visit.stage === 1 ? 'context' : 'meaning',
            round: visit.stage + 1,
            completedRounds: visit.stage,
            revealed: visit.stage === 0 || visit.initial !== undefined,
          },
        }
      : day?.phase === 'learning' && day.memory && currentLearningWord(day)
        ? {
            currentLearning: {
              word: currentLearningWord(day),
              stage:
                day.memory.round === 1
                  ? 'initial'
                  : day.memory.round === 2
                    ? 'context'
                    : day.memory.round === 3
                      ? 'meaning'
                      : 'spelling',
              round: day.memory.round,
              completedRounds:
                day.memory.progress.find((item) => sameWord(item.word, currentLearningWord(day)))
                  ?.completedRounds ?? 0,
              revealed: day.memory.revealed,
            },
          }
        : {}),
    focusItems: state.teaching.focusItems.filter((focus) =>
      focus.senseIds.some((id) => targets.includes(id)),
    ),
    memories: state.teaching.memories,
    currentProbe:
      state.scheduling.probes.find((probe) => probe.id === state.scheduling.activeProbeId) ?? null,
    currentDictation:
      state.practice.dictations.find((item) => item.id === state.practice.activeDictationId) ??
      null,
    summary: {
      activityDays: days.size,
      lastActivityAt: actual.reduce<number | null>(
        (latest, item) => (latest === null ? item.at : Math.max(latest, item.at)),
        null,
      ),
      viewedLexemes: new Set(
        actual
          .filter((item) => item.kind === 'view')
          .map((item) => item.word?.spelling.trim().toLowerCase()),
      ).size,
      firstSpellingAttempts: actual.filter(
        (item) => item.kind === 'spelling' && item.data.kind === 'first',
      ).length,
      translationAttempts: actual.filter((item) => item.kind === 'translation').length,
      ...(state.ledger.days.some((day) => day.memory || day.flow)
        ? {
            memoryRoundAdvances: actual.filter(
              (item) => item.kind === 'memory' && item.data.undoneAt === undefined,
            ).length,
            skippedSpellingWords: new Set(
              actual
                .filter((item) => item.kind === 'spelling_skip' && item.word)
                .map((item) => item.word && miniSenseId(item.word)),
            ).size,
            highPriorityWords: state.scheduling.cards.filter(
              (card) => (card.practicePriority ?? 0) > 0,
            ).length,
          }
        : {}),
      coverage: 'recorded_events_only',
    },
    focusBudget: {
      activePerSense: 2,
      newPerDay: 1,
      remainingForDay:
        day && !state.teaching.focusItems.some((focus) => focus.source.dayId === day.id) ? 1 : 0,
    },
  });
}
export function miniWordContext(state: MiniSnapshot, raw: MiniWordContextInput) {
  const input = miniWordContextInputSchema.parse(raw);
  requireFact(knownWord(state, input.word), '未找到这个词义的真实学习记录。');
  const focusItems = focusForWord(state, input.word);
  return miniWordContextSchema.parse({
    revision: state.revision,
    senseId: miniSenseId(input.word),
    word: input.word,
    memory: state.scheduling.cards.find((card) => card.senseId === miniSenseId(input.word)) ?? null,
    flowMemory:
      state.scheduling.flow.cards.find((card) => wordKey(card.word) === wordKey(input.word)) ??
      null,
    probes: state.scheduling.probes
      .filter((probe) => miniSenseId(probe.word) === miniSenseId(input.word))
      .slice(-input.limit),
    dictations: state.practice.dictations
      .filter((item) => miniSenseId(item.word) === miniSenseId(input.word))
      .slice(-input.limit),
    focusItems,
    history: miniHistoryPage(state, { word: input.word, limit: input.limit }),
    focusBudget: {
      active: focusItems.filter((item) => item.status === 'active').length,
      maximum: 2,
    },
  });
}
