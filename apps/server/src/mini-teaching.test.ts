import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  miniCommandSchema,
  miniHistoryPageSchema,
  miniSnapshotSchema,
  type MiniAction,
  type MiniCommand,
  type MiniWord,
} from '@lingoweave/contracts';
import { z } from 'zod';
import { LearningError } from './learning-store.js';
import { MiniStore } from './mini-store.js';
import { currentTranslation, swiftTime } from './mini-study.js';
import { miniSenseId } from './mini-teaching.js';

const timezone = 'Asia/Shanghai';
const apple: MiniWord = { spelling: 'apple', meaning: '苹果', phonetic: '/ˈæpəl/' };
const bank: MiniWord = { spelling: 'bank', meaning: '银行', phonetic: '' };
const river: MiniWord = { spelling: 'bank', meaning: '河岸', phonetic: '' };
const hasCode = (code: string) => (error: unknown) =>
  error instanceof LearningError && error.code === code;
function fixture(t: TestContext, filename = ':memory:') {
  let date = new Date('2026-11-13T04:00:00Z');
  let store = new MiniStore(filename, { timezone, now: () => date });
  t.after(() => store.close());
  store.importLegacy({
    requestId: randomUUID(),
    ledger: { days: [] },
    reviewRecord: null,
    reviewHistory: [],
    timezone,
  });
  const command = (
    action: z.input<typeof miniCommandSchema>['action'],
    extra: Partial<Omit<MiniCommand, 'action'>> = {},
  ) =>
    miniCommandSchema.parse({
      requestId: randomUUID(),
      expectedRevision: store.snapshot().revision,
      action,
      ...extra,
    });
  const act = (action: z.input<typeof miniCommandSchema>['action']) =>
    store.command(command(action));
  const day = () => {
    const result = store
      .snapshot()
      .ledger.days.find((item) => item.id === store.snapshot().planning.activeDayId);
    assert.ok(result);
    return result;
  };
  return {
    get store() {
      return store;
    },
    command,
    act,
    day,
    begin(words = [apple]) {
      return act({ type: 'begin', target: 'daily', deck: words, timezone });
    },
    context() {
      return { target: 'daily' as const, dayId: day().id };
    },
    setDate(value: string) {
      date = new Date(value);
    },
    reopen() {
      store.close();
      store = new MiniStore(filename, { timezone, now: () => date });
    },
    learn() {
      const context = { target: 'daily' as const, dayId: day().id };
      for (const word of day().learningWords) {
        if (!day().sentences.some((item) => item.word.meaning === word.meaning))
          act({
            ...context,
            type: 'add_sentences',
            sentences: [
              { word, english: `I see ${word.spelling}.`, chinese: `我看见${word.meaning}。` },
            ],
          });
        act({ ...context, type: 'mark_studied', word });
      }
      while (day().learning?.queue[0]) {
        const word = day().learning?.queue[0];
        assert.ok(word);
        act({
          ...context,
          type: 'submit_spelling',
          session: 'learning',
          word,
          answer: word.spelling,
        });
      }
      act({ ...context, type: 'complete_learning' });
    },
    prepare() {
      const current = day();
      return act({
        target: 'daily',
        dayId: current.id,
        type: 'publish_writing',
        prompts: [...current.reviewWords, ...current.learningWords].map((word, index) => {
          const direction = current.directions[index];
          assert.ok(direction);
          return {
            id: randomUUID(),
            sentence: {
              word,
              english: `We need ${word.spelling} today.`,
              chinese: `我们今天需要${word.meaning}。`,
            },
            direction,
            focusIds: [],
          };
        }),
      });
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
function focus(data: Fixture, expression = 'an apple') {
  return data
    .act({
      ...data.context(),
      type: 'create_focus',
      words: [apple],
      expression,
      explanation: '常见数量表达。',
      reason: '优先练习日常常见用法。',
    })
    .teaching.focusItems.at(-1);
}
const qualitative = {
  comment: '意思清楚。',
  tip: '可以留意冠词。',
  usefulPhrase: 'an apple',
  strengths: ['表达了核心意思'],
  improvements: ['加上冠词'],
  keyPoints: ['可数名词单数的限定词'],
  referenceTranslation: 'We need an apple today.',
};
function finishWriting(data: Fixture) {
  const task = currentTranslation(data.day());
  assert.ok(task);
  data.act({
    ...data.context(),
    type: 'submit_translation',
    taskId: task.id,
    answer: '真正用户原答',
  });
  const attempt = data.day().translation.at(-1);
  assert.ok(attempt);
  data.store.aiCommand(
    data.command({
      ...data.context(),
      type: 'qualitative_feedback',
      attemptId: attempt.id,
      feedback: qualitative,
    }),
  );
  data.act({ ...data.context(), type: 'advance_translation', taskId: task.id });
}
function review(data: Fixture) {
  data.act({
    ...data.context(),
    type: 'choose_judgment',
    session: 'review',
    word: apple,
    judgment: 'clear',
  });
  data.act({ ...data.context(), type: 'advance_judgment', session: 'review', word: apple });
  data.act({
    ...data.context(),
    type: 'submit_spelling',
    session: 'review',
    word: apple,
    answer: 'apple',
  });
  data.act({ ...data.context(), type: 'complete_review' });
}

test('AI domain exposes only allowed actions and writes use committed receipts with revision checks', (t) => {
  const data = fixture(t);
  data.begin();
  const original = data.store.snapshot();
  for (const action of [
    { ...data.context(), type: 'mark_studied' as const, word: apple },
    {
      ...data.context(),
      type: 'submit_spelling' as const,
      session: 'learning' as const,
      word: apple,
      answer: 'apple',
      advanceOnCorrect: true,
    },
    { type: 'begin' as const, target: 'daily' as const, deck: [apple], timezone },
  ])
    assert.throws(
      () => data.store.aiCommand(data.command(action)),
      hasCode('MINI_AI_ACTION_FORBIDDEN'),
    );
  assert.deepEqual(data.store.snapshot(), original);
  const input = data.command({
    type: 'set_session_plan',
    target: 'daily',
    wordLimit: 2,
    newWordLimit: 1,
  });
  const saved = data.store.aiCommand(input);
  assert.equal(saved.revision, original.revision + 1);
  assert.deepEqual(data.store.commandReceipt(input.requestId), {
    requestId: input.requestId,
    revision: saved.revision,
  });
  assert.deepEqual(data.store.aiCommand(input), saved);
  assert.throws(
    () =>
      data.store.aiCommand({ ...input, action: { type: 'clear_session_plan', target: 'daily' } }),
    hasCode('REQUEST_CONFLICT'),
  );
  assert.throws(
    () =>
      data.store.aiCommand(
        data.command({ type: 'clear_session_plan', target: 'daily' }, { expectedRevision: 0 }),
      ),
    hasCode('MINI_REVISION_CONFLICT'),
  );
  assert.equal(data.store.commandReceipt(randomUUID()), null);
});

test('new writing requires separate immutable prompts, qualitative feedback preserves original answers and schedules', (t) => {
  const data = fixture(t);
  data.begin();
  data.learn();
  assert.equal(data.day().writingMode, 'prepared');
  assert.equal(currentTranslation(data.day()), undefined);
  assert.throws(
    () =>
      data.act({
        ...data.context(),
        type: 'submit_translation',
        taskId: `${data.day().id}/0`,
        answer: '不能绕过备课',
      }),
    hasCode('MINI_STATE_CONFLICT'),
  );
  const example = data.day().sentences[0];
  assert.ok(example);
  const bad = data.command({
    ...data.context(),
    type: 'publish_writing',
    prompts: [{ id: randomUUID(), sentence: example, direction: 'englishToChinese', focusIds: [] }],
  });
  assert.throws(() => data.store.aiCommand(bad), hasCode('MINI_STATE_CONFLICT'));
  assert.equal(data.store.commandReceipt(bad.requestId), null);
  data.prepare();
  const task = currentTranslation(data.day());
  assert.ok(task?.materialId);
  assert.notEqual(task.sentence.english, example.english);
  const beforeSchedule = data.day().scheduleUpdates;
  data.act({
    ...data.context(),
    type: 'submit_translation',
    taskId: task.id,
    answer: '  真正的用户原答  ',
  });
  const attempt = data.day().translation.at(-1);
  assert.ok(attempt);
  const input = data.command({
    ...data.context(),
    type: 'qualitative_feedback',
    attemptId: attempt.id,
    feedback: qualitative,
  });
  data.store.aiCommand(input);
  data.store.aiCommand(input);
  assert.equal(data.day().translation[0]?.answer, '  真正的用户原答  ');
  assert.deepEqual(data.day().translation[0]?.task, task);
  assert.equal(data.day().translation[0]?.feedback?.outcome, undefined);
  assert.deepEqual(data.day().scheduleUpdates, beforeSchedule);
  assert.throws(() => data.prepare(), hasCode('MINI_STATE_CONFLICT'));
  assert.throws(() =>
    miniCommandSchema.parse({
      ...input,
      action: { ...input.action, feedback: { ...qualitative, outcome: 'correct' } },
    }),
  );
  data.act({ ...data.context(), type: 'advance_translation', taskId: task.id });
  assert.equal(data.day().phase, 'finished');
});

test('legacy unfinished writing remains readable without rewriting its original material or direction', (t) => {
  const data = fixture(t);
  data.begin();
  data.learn();
  const snapshot = data.store.snapshot();
  const legacyDay = snapshot.ledger.days[0];
  assert.ok(legacyDay);
  delete legacyDay.writingMode;
  delete legacyDay.writingPrompts;
  const legacy = new MiniStore(':memory:');
  t.after(() => legacy.close());
  legacy.importLegacy({
    requestId: randomUUID(),
    ledger: snapshot.ledger,
    reviewRecord: null,
    reviewHistory: [],
    timezone,
  });
  const day = legacy.snapshot().ledger.days[0];
  assert.ok(day);
  assert.equal(currentTranslation(day)?.sentence.english, legacyDay.sentences[0]?.english);
});

test('partial writing publication resumes missing targets without overwriting original prompts or submitted tasks', (t) => {
  const data = fixture(t);
  data.begin([apple, bank]);
  data.learn();
  const firstId = randomUUID();
  const firstPrompt = {
    id: firstId,
    sentence: { word: apple, english: 'She wants an apple.', chinese: '她想要一个苹果。' },
    direction: 'englishToChinese' as const,
    focusIds: [],
  };
  const invalidBatch = data.command({
    ...data.context(),
    type: 'publish_writing',
    prompts: [
      firstPrompt,
      {
        id: randomUUID(),
        sentence: { word: bank, english: 'The bank opens now.', chinese: '银行现在开门了。' },
        direction: 'englishToChinese',
        focusIds: [],
      },
    ],
  });
  const original = data.store.snapshot();
  assert.throws(() => data.store.aiCommand(invalidBatch), hasCode('MINI_STATE_CONFLICT'));
  assert.deepEqual(data.store.snapshot(), original);
  const publish = data.command({
    ...data.context(),
    type: 'publish_writing',
    prompts: [firstPrompt],
  });
  data.store.aiCommand(publish);
  data.store.aiCommand(publish);
  assert.equal(data.day().writingPrompts?.length, 1);
  finishWriting(data);
  const firstAttempt = data.day().translation[0];
  assert.ok(firstAttempt);
  assert.equal(data.day().phase, 'translation');
  assert.equal(currentTranslation(data.day()), undefined);
  assert.throws(
    () =>
      data.act({
        ...data.context(),
        type: 'publish_writing',
        prompts: [
          {
            ...firstPrompt,
            sentence: { ...firstPrompt.sentence, english: 'A replacement apple sentence.' },
          },
        ],
      }),
    hasCode('MINI_STATE_CONFLICT'),
  );
  data.act({
    ...data.context(),
    type: 'publish_writing',
    prompts: [
      {
        id: randomUUID(),
        sentence: { word: bank, english: 'The bank opens now.', chinese: '银行现在开门了。' },
        direction: 'chineseToEnglish',
        focusIds: [],
      },
    ],
  });
  assert.equal(currentTranslation(data.day())?.sentence.word.meaning, bank.meaning);
  assert.deepEqual(data.day().translation[0], firstAttempt);
  assert.equal(data.day().writingPrompts?.[0]?.id, firstId);
});

test('focus identity follows the sense, limits new expansion per group and archive cannot reset its budget', (t) => {
  const data = fixture(t);
  data.begin();
  const one = focus(data);
  assert.ok(one);
  assert.equal(
    miniSenseId({ ...apple, spelling: ' APPLE ', phonetic: 'changed' }),
    miniSenseId(apple),
  );
  assert.notEqual(miniSenseId(bank), miniSenseId(river));
  assert.throws(() => focus(data, 'apple juice'), hasCode('MINI_TEACHING_CONFLICT'));
  data.act({
    ...data.context(),
    type: 'update_focus',
    focusId: one.id,
    status: 'archived',
    reason: '暂时不练。',
  });
  assert.throws(() => focus(data, 'apple juice'), hasCode('MINI_TEACHING_CONFLICT'));
  assert.equal(data.store.wordContext({ word: apple }).focusItems[0]?.status, 'archived');
  assert.equal(data.store.aiContext({ timezone }).focusBudget.remainingForDay, 0);
  assert.equal(data.store.snapshot().teaching.focusItems[0]?.changes.length, 2);
  assert.throws(
    () =>
      data.act({
        ...data.context(),
        type: 'create_focus',
        words: [bank],
        expression: 'at the bank',
        explanation: '常用地点',
        reason: '关联外部词义',
      }),
    hasCode('MINI_TEACHING_CONFLICT'),
  );
});

test('focus links require a real matching active sense and remain attached to history after archiving', (t) => {
  const data = fixture(t);
  data.begin();
  const item = focus(data);
  assert.ok(item);
  data.learn();
  const prompt: MiniAction = {
    ...data.context(),
    type: 'publish_writing',
    prompts: [
      {
        id: randomUUID(),
        sentence: { word: apple, english: 'She wants an apple.', chinese: '她想要一个苹果。' },
        direction: 'englishToChinese',
        focusIds: [item.id],
      },
    ],
  };
  data.act(prompt);
  data.act({
    ...data.context(),
    type: 'update_focus',
    focusId: item.id,
    status: 'archived',
    reason: '已安排后暂缓新增。',
  });
  assert.deepEqual(currentTranslation(data.day())?.focusIds, [item.id]);
  assert.equal(
    miniSnapshotSchema.parse(data.store.snapshot()).teaching.focusItems[0]?.status,
    'archived',
  );
});

test('two active focuses per sense are enforced across groups and deferred focus can restore only within capacity', (t) => {
  const data = fixture(t);
  data.begin();
  const first = focus(data);
  assert.ok(first);
  data.learn();
  data.prepare();
  finishWriting(data);
  data.setDate('2026-11-16T04:00:00Z');
  data.begin();
  const second = focus(data, 'apple juice');
  assert.ok(second);
  review(data);
  data.prepare();
  finishWriting(data);
  data.setDate('2026-11-23T04:00:00Z');
  data.begin();
  assert.throws(() => focus(data, 'apple pie'), hasCode('MINI_TEACHING_CONFLICT'));
  data.act({
    ...data.context(),
    type: 'update_focus',
    focusId: first.id,
    status: 'deferred',
    reason: '本轮先复练其他重点。',
  });
  const third = focus(data, 'apple pie');
  assert.ok(third);
  assert.throws(
    () =>
      data.act({
        ...data.context(),
        type: 'update_focus',
        focusId: first.id,
        status: 'active',
        reason: '不能绕过每词义容量。',
      }),
    hasCode('MINI_TEACHING_CONFLICT'),
  );
  assert.equal(data.store.wordContext({ word: apple }).focusBudget.active, 2);
  assert.equal(data.store.wordContext({ word: apple }).focusItems.length, 3);
});

test('persistent preferences require authorized saved user sources, are bounded, editable and deletable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lingoweave-mini-memories-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'mini.sqlite');
  const data = fixture(t, filename);
  const messageId = randomUUID();
  const input = data.command({
    type: 'remember_preference',
    target: 'daily',
    key: 'accent',
    value: 'deleted personal preference',
    sourceMessageId: messageId,
  });
  assert.throws(() => data.store.aiCommand(input), hasCode('MINI_MEMORY_SOURCE_REQUIRED'));
  assert.throws(
    () => data.store.aiCommand(input, { sourceMessageId: randomUUID() }),
    hasCode('MINI_MEMORY_SOURCE_REQUIRED'),
  );
  data.store.aiCommand(input, { sourceMessageId: messageId });
  const memory = data.store.snapshot().teaching.memories[0];
  assert.ok(memory);
  const edit = data.command({
    type: 'remember_preference',
    target: 'daily',
    key: 'accent',
    value: '美式',
    sourceMessageId: messageId,
  });
  data.store.aiCommand(edit, { sourceMessageId: messageId });
  assert.equal(data.store.snapshot().teaching.memories[0]?.id, memory.id);
  for (let index = 1; index < 20; index += 1)
    data.store.aiCommand(
      data.command({
        type: 'remember_preference',
        target: 'daily',
        key: `preference-${index}`,
        value: '明确偏好',
        sourceMessageId: messageId,
      }),
      { sourceMessageId: messageId },
    );
  assert.throws(
    () =>
      data.store.aiCommand(
        data.command({
          type: 'remember_preference',
          target: 'daily',
          key: 'too-many',
          value: '超限',
          sourceMessageId: messageId,
        }),
        { sourceMessageId: messageId },
      ),
    hasCode('MINI_TEACHING_CONFLICT'),
  );
  data.store.aiCommand(
    data.command({
      type: 'forget_preference',
      target: 'daily',
      memoryId: memory.id,
      sourceMessageId: messageId,
    }),
    { sourceMessageId: messageId },
  );
  data.reopen();
  assert.equal(data.store.snapshot().teaching.memories.length, 19);
  assert.ok(!data.store.snapshot().teaching.memories.some((item) => item.id === memory.id));
  const database = new DatabaseSync(filename);
  t.after(() => database.close());
  assert.ok(
    database
      .prepare('SELECT body FROM mini_events')
      .all()
      .every(
        (row) =>
          !z.object({ body: z.string() }).parse(row).body.includes('deleted personal preference'),
      ),
  );
});

test('history pages include exact imported facts, keep first answers and reject cursors from another revision/filter', (t) => {
  const data = fixture(t);
  data.begin([apple, bank]);
  data.learn();
  data.prepare();
  const snapshot = data.store.snapshot();
  const imported = new MiniStore(':memory:');
  t.after(() => imported.close());
  imported.importLegacy({
    requestId: randomUUID(),
    ledger: snapshot.ledger,
    reviewRecord: null,
    reviewHistory: [],
    timezone,
  });
  const before = imported.snapshot();
  const first = miniHistoryPageSchema.parse(imported.history({ limit: 1 }));
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const next = imported.history({ limit: 1, cursor: first.nextCursor });
  assert.notEqual(next.items[0]?.id, first.items[0]?.id);
  assert.throws(
    () => imported.history({ kind: 'spelling', cursor: first.nextCursor ?? undefined }),
    hasCode('MINI_HISTORY_CURSOR_STALE'),
  );
  const spelling = imported.history({ kind: 'spelling', word: apple });
  assert.equal(spelling.items[0]?.data.answer, 'apple');
  assert.deepEqual(imported.snapshot(), before);
  imported.command(
    miniCommandSchema.parse({
      requestId: randomUUID(),
      expectedRevision: before.revision,
      action: {
        type: 'set_session_plan',
        target: 'daily',
        wordLimit: 1,
        newWordLimit: 0,
      },
    }),
  );
  assert.throws(
    () => imported.history({ cursor: first.nextCursor ?? undefined }),
    hasCode('MINI_HISTORY_CURSOR_STALE'),
  );
  assert.equal(imported.history({ kind: 'plan' }).items[0]?.data.type, 'set_session_plan');
});

test('chat help is committed to the exact target before spelling and cannot yield independent review promotion', (t) => {
  const data = fixture(t);
  data.begin();
  data.learn();
  data.prepare();
  const task = currentTranslation(data.day());
  assert.ok(task);
  data.act({
    ...data.context(),
    type: 'submit_translation',
    taskId: task.id,
    answer: '我原来的答案',
  });
  const attempt = data.day().translation[0];
  assert.ok(attempt);
  data.store.aiCommand(
    data.command({
      ...data.context(),
      type: 'qualitative_feedback',
      attemptId: attempt.id,
      feedback: qualitative,
    }),
  );
  data.act({ ...data.context(), type: 'advance_translation', taskId: task.id });
  data.setDate('2026-11-16T04:00:00Z');
  data.begin();
  data.act({
    ...data.context(),
    type: 'choose_judgment',
    session: 'review',
    word: apple,
    judgment: 'clear',
  });
  data.act({ ...data.context(), type: 'advance_judgment', session: 'review', word: apple });
  const original = data.store.snapshot();
  assert.throws(
    () =>
      data.store.aiCommand(
        data.command({
          ...data.context(),
          type: 'record_exposure',
          session: 'review',
          word: bank,
          kind: 'potentialHelp',
          source: 'chat',
        }),
      ),
    hasCode('MINI_TEACHING_CONFLICT'),
  );
  assert.deepEqual(data.store.snapshot(), original);
  const help = data.command({
    ...data.context(),
    type: 'record_exposure',
    session: 'review',
    word: apple,
    kind: 'potentialHelp',
    source: 'chat',
    sourceMessageId: randomUUID(),
  });
  data.store.aiCommand(help);
  data.store.aiCommand(help);
  assert.equal(data.store.snapshot().teaching.exposures.length, 1);
  data.act({
    ...data.context(),
    type: 'submit_spelling',
    session: 'review',
    word: apple,
    answer: 'apple',
  });
  assert.equal(
    data.day().review?.spellingAttempts[0]?.lastPotentialHelpAt,
    swiftTime(new Date('2026-11-16T04:00:00Z')),
  );
  data.act({ ...data.context(), type: 'complete_review' });
  assert.equal(data.day().scheduleUpdates.find((item) => item.source === 'review')?.step, 0);
});

test('AI preparation and preference changes never fabricate user activity in advisor summaries', (t) => {
  const data = fixture(t);
  data.begin();
  focus(data);
  data.act({
    ...data.context(),
    type: 'add_sentences',
    sentences: [{ word: apple, english: 'I see an apple.', chinese: '我看见一个苹果。' }],
  });
  const summary = data.store.aiContext({ timezone }).summary;
  assert.equal(summary.activityDays, 0);
  assert.equal(summary.lastActivityAt, null);
  data.act({ ...data.context(), type: 'mark_studied', word: apple });
  assert.equal(data.store.aiContext({ timezone }).summary.activityDays, 1);
  assert.equal(data.store.aiContext({ timezone }).summary.viewedLexemes, 1);
  assert.throws(() => data.store.wordContext({ word: river }), hasCode('MINI_TEACHING_CONFLICT'));
});

test('help after an incorrect first answer keeps that original fact unchanged even with identical clock timestamps', (t) => {
  const data = fixture(t);
  data.begin();
  data.act({
    ...data.context(),
    type: 'add_sentences',
    sentences: [{ word: apple, english: 'I see an apple.', chinese: '我看见一个苹果。' }],
  });
  data.act({ ...data.context(), type: 'mark_studied', word: apple });
  data.act({
    ...data.context(),
    type: 'submit_spelling',
    session: 'learning',
    word: apple,
    answer: 'aple',
  });
  const original = data.day().learning?.spellingAttempts[0];
  assert.ok(original);
  data.store.aiCommand(
    data.command({
      ...data.context(),
      type: 'record_exposure',
      session: 'learning',
      word: apple,
      kind: 'answerReveal',
      source: 'chat',
    }),
  );
  data.act({
    ...data.context(),
    type: 'submit_spelling',
    session: 'learning',
    word: apple,
    answer: 'apple',
  });
  assert.deepEqual(data.day().learning?.spellingAttempts[0], original);
  assert.ok(data.day().learning?.spellingAttempts[1]?.lastPotentialHelpAt !== undefined);
  assert.equal(data.store.snapshot().teaching.exposures[0]?.beforeAttemptCount, 1);
  const altered = data.store.snapshot();
  const first = altered.ledger.days[0]?.learning?.spellingAttempts[0];
  assert.ok(first);
  first.lastPotentialHelpAt = swiftTime(new Date('2026-11-13T04:00:00Z'));
  const imported = new MiniStore(':memory:');
  t.after(() => imported.close());
  assert.throws(
    () =>
      imported.importLegacy({
        requestId: randomUUID(),
        ledger: altered.ledger,
        reviewRecord: null,
        reviewHistory: [],
        timezone,
      }),
    hasCode('MINI_TEACHING_CONFLICT'),
  );
});
