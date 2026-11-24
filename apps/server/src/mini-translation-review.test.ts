import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { miniTranslationReviewSchema, type MiniDay } from '@lingoweave/contracts';
import { pendingMeaningComment, translationReview } from './mini-translation-review.js';
import { swiftTime } from './mini-study.js';

const word = { spelling: 'book', meaning: '书', phonetic: '' };
const sentence = { word, english: 'I read this book.', chinese: '我读这本书。' };
function attempt(
  when: string,
  direction: 'englishToChinese' | 'chineseToEnglish',
): MiniDay['translation'][number] {
  return {
    id: randomUUID(),
    task: { id: randomUUID(), sentence, direction },
    answer: direction === 'englishToChinese' ? '我读过这本书。' : 'I read the book.',
    submittedAt: swiftTime(new Date(when)),
  };
}
const query = { date: '2026-11-18', timezone: 'Asia/Shanghai' };

test('daily review follows the submission date across midnight, resumed groups and direction; old feedback excludes grades', () => {
  const yesterday = attempt('2026-11-17T15:59:59Z', 'englishToChinese');
  const midnight = attempt('2026-11-17T16:00:00Z', 'chineseToEnglish');
  midnight.feedback = {
    outcome: 'partial',
    comment: '意思清楚。',
    tip: '这里可以用 this。',
    usefulPhrase: 'read this book',
  };
  const tonight = attempt('2026-11-18T15:59:59Z', 'englishToChinese');
  const tomorrow = attempt('2026-11-18T16:00:00Z', 'englishToChinese');
  const days = [
    { id: 'old-group', translation: [yesterday, midnight] },
    { id: 'later-group', translation: [tonight, tomorrow] },
  ];
  const none = () => {
    throw new Error('unconfirmed or legacy attempts have no scheduled assessment');
  };
  const review = miniTranslationReviewSchema.parse(translationReview(days, query, none));
  assert.deepEqual(
    review.entries.map((e) => [e.attemptId, e.dayId, e.question, e.status, e.answer]),
    [
      [tonight.id, 'later-group', sentence.english, 'submitted', tonight.answer],
      [midnight.id, 'old-group', sentence.chinese, 'ready', midnight.answer],
    ],
  );
  assert.deepEqual(review.entries[1]?.commentary, {
    summary: '意思清楚。',
    strengths: [],
    improvements: ['这里可以用 this。'],
    keyPoints: ['read this book'],
    referenceTranslation: sentence.english,
  });
  const utc = translationReview(days, { ...query, timezone: 'UTC' }, none);
  assert.deepEqual(
    utc.entries.map((e) => e.attemptId),
    [tomorrow.id, tonight.id],
  );
});

test('daily review keeps all attempts including more than fifty on the same word and exposes retry identity only for failed jobs', () => {
  const attempts = Array.from({ length: 55 }, (_, i) => {
    const entry = attempt('2026-11-18T03:00:00Z', 'englishToChinese');
    entry.submittedAt += i;
    entry.confirmedAt = entry.submittedAt + 1;
    return entry;
  });
  const first = attempts[0],
    second = attempts[1];
  assert.ok(first && second);
  const review = translationReview([{ id: 'one-day', translation: attempts }], query, (id) => ({
    status: id === first.id ? 'failed' : id === second.id ? 'running' : 'queued',
    result: null,
  }));
  assert.equal(review.entries.length, 55);
  assert.deepEqual(
    review.entries.filter((e) => e.retryJobId).map((e) => e.retryJobId),
    [first.id],
  );
  assert.equal(review.entries.find((e) => e.attemptId === second.id)?.status, 'running');
});

test('a revision keeps one row on the original day and looks up feedback and retries by its own ID', () => {
  const original = attempt('2026-11-18T15:59:00Z', 'englishToChinese');
  original.confirmedAt = original.submittedAt + 5;
  original.feedback = { comment: '旧稿点评', tip: '旧建议', usefulPhrase: 'read a book' };
  const revision = {
    id: randomUUID(),
    answer: '我读这本书。',
    submittedAt: original.submittedAt + 120,
  };
  original.revisions = [revision];
  const days = [{ id: 'day', translation: [original] }];
  const get = (date: string) =>
    translationReview(days, { ...query, date }, (id) => {
      assert.equal(id, revision.id);
      return { status: 'failed', result: null };
    }).entries;
  assert.deepEqual(get('2026-11-19'), []);
  // Fixed groups advance by their translation cursor and may have no confirmedAt.
  delete original.confirmedAt;
  const rows = get(query.date);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    attemptId: original.id,
    answerRevisionId: revision.id,
    dayId: 'day',
    word,
    direction: 'englishToChinese',
    submittedAt: original.submittedAt,
    question: sentence.english,
    answer: revision.answer,
    status: 'failed',
    commentary: null,
    retryJobId: revision.id,
  });
});

test('old English-to-Chinese middle grades reuse matching independent references only for safe variants', () => {
  function publicReview(answer: string, reference: string, reviewed?: string) {
    const item = attempt('2026-11-18T09:30:00Z', 'englishToChinese');
    item.task.sentence = { ...item.task.sentence, chinese: reference };
    item.answer = answer;
    item.feedback = {
      comment: '整句意思都译对了，不过应加一个逗号。',
      tip: '加逗号。',
      usefulPhrase: '',
      expressionGrade: 'understandable',
      referenceTranslation: reviewed,
    };
    const row = translationReview([{ id: 'day', translation: [item] }], query, () => null)
      .entries[0];
    assert.ok(row);
    return pendingMeaningComment(row);
  }
  const original = '再见，爸爸！我今晚给你打电话。';
  const alternate = '再见爸爸，我今晚给你打电话。';
  const row = publicReview(alternate, original, original);
  assert.equal(row.expressionGrade, 'natural');
  assert.deepEqual(row.commentary?.improvements, []);
  assert.equal(row.commentary?.summary.includes('逗号'), false);
  assert.equal(row.commentary?.referenceTranslation, original);
  for (const [answer, question, reviewed] of [
    [alternate, original, undefined],
    [alternate, original, '我明早给你打电话。'],
    ['不要走。', '不，要走。', '不，要走。'],
    ['我还有1。5元。', '我还有1.5元。', '我还有1.5元。'],
    ['你今天来。', '你今天来？', '你今天来？'],
    ['我去。', '我不去。', '我不去。'],
  ] as const) {
    const uncertain = publicReview(answer, question, reviewed);
    assert.equal(uncertain.expressionGrade, undefined);
    assert.equal(uncertain.commentary, null);
  }
});
