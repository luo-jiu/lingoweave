import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canStartNextRound,
  canStartSpelling,
  canSubmitRound,
  createReviewState,
  demoReviewWords,
  getSessionStages,
  reviewReducer,
  type ReviewState,
} from '../src/features/study-demo.ts';

function rateAll(state = createReviewState()): ReviewState {
  return state.activeIds.reduce(
    (current, wordId) => reviewReducer(current, { type: 'rate', wordId, rating: 'clear' }),
    state,
  );
}

function beginSpelling(): ReviewState {
  return reviewReducer(rateAll(), { type: 'start-spelling' });
}

function answerAll(state: ReviewState, answers: Readonly<Record<string, string>>): ReviewState {
  return state.activeIds.reduce(
    (current, wordId) =>
      reviewReducer(current, { type: 'input', wordId, value: answers[wordId] ?? 'wrong' }),
    state,
  );
}

test('recall requires every rating and allows correction before starting spelling', () => {
  let state = createReviewState();
  assert.equal(canStartSpelling(state), false);
  assert.equal(reviewReducer(state, { type: 'start-spelling' }), state);
  state = reviewReducer(state, { type: 'rate', wordId: 'apple', rating: 'clear' });
  state = reviewReducer(state, { type: 'rate', wordId: 'apple', rating: 'forgotten' });
  assert.equal(state.ratings.apple, 'forgotten');
  assert.equal(canStartSpelling(state), false);
  state = rateAll(state);
  assert.equal(canStartSpelling(state), true);
  state = reviewReducer(state, { type: 'start-spelling' });
  assert.equal(state.phase, 'spelling');
  assert.equal(reviewReducer(state, { type: 'rate', wordId: 'apple', rating: 'fuzzy' }), state);
});

test('clicking the selected rating withdraws it and reopens the spelling gate without making a result', () => {
  for (const rating of ['forgotten', 'fuzzy', 'clear'] as const) {
    const initial = createReviewState();
    const rated = reviewReducer(initial, { type: 'rate', wordId: 'apple', rating });
    const undone = reviewReducer(rated, { type: 'rate', wordId: 'apple', rating });
    assert.deepEqual(undone.ratings, {});
    assert.equal(rated.ratings.apple, rating);
    assert.deepEqual(undone.rounds, []);
    assert.deepEqual(undone.passedIds, []);
  }
  const rated = rateAll();
  assert.equal(canStartSpelling(rated), true);
  const undone = reviewReducer(rated, { type: 'rate', wordId: 'apple', rating: 'clear' });
  assert.equal(Object.keys(undone.ratings).length, 4);
  assert.equal(canStartSpelling(undone), false);
  assert.equal(reviewReducer(undone, { type: 'start-spelling' }), undone);
});

test('unanswered inputs block the entire batch instead of producing failures', () => {
  let state = beginSpelling();
  state = reviewReducer(state, { type: 'input', wordId: 'apple', value: 'apple' });
  state = reviewReducer(state, { type: 'input', wordId: 'book', value: '  ' });
  assert.equal(canSubmitRound(state), false);
  assert.equal(reviewReducer(state, { type: 'submit' }), state);
  assert.equal(state.rounds.length, 0);
  assert.deepEqual(state.passedIds, []);
  for (const wordId of ['book', 'water', 'read', 'write']) {
    state = reviewReducer(state, { type: 'unknown', wordId, value: true });
  }
  assert.equal(canSubmitRound(state), true);
  state = reviewReducer(state, { type: 'submit' });
  assert.deepEqual(state.passedIds, ['apple']);
  assert.equal(state.rounds[0]?.attempts.filter((attempt) => attempt.unknown).length, 4);
});

test('explicit unknown is reversible and editing an input clears its unknown flag', () => {
  let state = beginSpelling();
  state = reviewReducer(state, { type: 'unknown', wordId: 'apple', value: true });
  state = reviewReducer(state, { type: 'unknown', wordId: 'apple', value: true });
  assert.deepEqual(state.unknownIds, ['apple']);
  state = reviewReducer(state, { type: 'unknown', wordId: 'apple', value: false });
  assert.deepEqual(state.unknownIds, []);
  state = reviewReducer(state, { type: 'unknown', wordId: 'apple', value: true });
  state = reviewReducer(state, { type: 'input', wordId: 'apple', value: 'apple' });
  assert.deepEqual(state.unknownIds, []);
  assert.equal(state.rounds.length, 0);
});

test('batch grading preserves exact submitted text while accepting case and outer whitespace', () => {
  let state = answerAll(beginSpelling(), {
    apple: '  APPLE ',
    book: 'book',
    water: 'Water',
    read: ' read ',
    write: 'write',
  });
  assert.deepEqual(state.passedIds, []);
  assert.equal(state.rounds.length, 0);
  state = reviewReducer(state, { type: 'submit' });
  assert.equal(state.phase, 'complete');
  assert.equal(state.passedIds.length, 5);
  assert.deepEqual(state.rounds[0]?.attempts[0], {
    wordId: 'apple',
    answer: '  APPLE ',
    unknown: false,
    correct: true,
  });
  assert.equal(reviewReducer(state, { type: 'submit' }), state);
});

test('only wrong words retry after acknowledgement, with hidden cleared answers and a new order', () => {
  let state = reviewReducer(
    answerAll(beginSpelling(), { apple: 'aple', book: 'book', water: 'watre', read: 'read' }),
    { type: 'submit' },
  );
  assert.deepEqual(state.activeIds, ['apple', 'water', 'write']);
  assert.deepEqual(state.passedIds, ['book', 'read']);
  const previousRound = state.rounds[0];
  const previousIds = state.activeIds;
  assert.equal(canStartNextRound(state), false);
  assert.equal(reviewReducer(state, { type: 'next-round' }), state);
  for (const wordId of state.activeIds) {
    state = reviewReducer(state, { type: 'acknowledge', wordId });
  }
  assert.equal(canStartNextRound(state), true);
  state = reviewReducer(state, { type: 'next-round' });
  assert.equal(state.phase, 'spelling');
  assert.deepEqual([...state.activeIds].sort(), [...previousIds].sort());
  assert.notDeepEqual(state.activeIds, previousIds);
  assert.deepEqual(state.inputs, {});
  assert.deepEqual(state.unknownIds, []);
  assert.deepEqual(state.acknowledgedIds, []);
  assert.equal(state.rounds[0], previousRound);
  state = reviewReducer(answerAll(state, { apple: 'apple', water: 'water', write: 'write' }), {
    type: 'submit',
  });
  assert.equal(state.phase, 'complete');
  assert.equal(state.rounds.length, 2);
  assert.equal(
    state.rounds[0]?.attempts.find((attempt) => attempt.wordId === 'apple')?.answer,
    'aple',
  );
  assert.equal(
    state.rounds[0]?.attempts.find((attempt) => attempt.wordId === 'apple')?.correct,
    false,
  );
  assert.equal(
    state.rounds[1]?.attempts.find((attempt) => attempt.wordId === 'apple')?.correct,
    true,
  );
  assert.equal(new Set(state.passedIds).size, 5);
  assert.equal(state.rounds[1]?.attempts.length, 3);
});

test('pausing retains drafts and prevents progress until resume', () => {
  let state = beginSpelling();
  state = reviewReducer(state, { type: 'input', wordId: 'apple', value: 'app' });
  state = reviewReducer(state, { type: 'pause' });
  assert.equal(state.paused, true);
  assert.equal(reviewReducer(state, { type: 'input', wordId: 'apple', value: 'apple' }), state);
  assert.equal(reviewReducer(state, { type: 'submit' }), state);
  assert.equal(canSubmitRound(state), false);
  state = reviewReducer(state, { type: 'resume' });
  assert.equal(state.inputs.apple, 'app');
  assert.equal(state.phase, 'spelling');
  assert.equal(state.rounds.length, 0);
});

test('deferring a stubborn word ends the session without inventing a pass or losing its failure', () => {
  let state = reviewReducer(
    answerAll(beginSpelling(), {
      apple: 'aple',
      book: 'book',
      water: 'water',
      read: 'read',
      write: 'write',
    }),
    { type: 'submit' },
  );
  const originalRound = state.rounds[0];
  state = reviewReducer(state, { type: 'defer', wordId: 'apple' });
  assert.equal(state.phase, 'complete');
  assert.deepEqual(state.activeIds, []);
  assert.deepEqual(state.deferredIds, ['apple']);
  assert.equal(state.passedIds.includes('apple'), false);
  assert.equal(state.rounds[0], originalRound);
  assert.equal(reviewReducer(state, { type: 'defer', wordId: 'apple' }), state);
});

test('deferring one wrong word keeps acknowledgement gates for the remaining words', () => {
  let state = reviewReducer(answerAll(beginSpelling(), {}), { type: 'submit' });
  state = reviewReducer(state, { type: 'defer', wordId: 'apple' });
  assert.equal(state.phase, 'correction');
  assert.equal(canStartNextRound(state), false);
  for (const wordId of state.activeIds) {
    state = reviewReducer(state, { type: 'acknowledge', wordId });
  }
  state = reviewReducer(state, { type: 'next-round' });
  assert.equal(state.activeIds.includes('apple'), false);
  assert.deepEqual(state.deferredIds, ['apple']);
  assert.deepEqual(state.passedIds, []);
});

test('stale phase actions and words outside the batch cannot alter the demo state', () => {
  const state = createReviewState();
  assert.equal(reviewReducer(state, { type: 'input', wordId: 'apple', value: 'apple' }), state);
  assert.equal(reviewReducer(state, { type: 'defer', wordId: 'apple' }), state);
  assert.equal(reviewReducer(state, { type: 'rate', wordId: 'unrelated', rating: 'clear' }), state);
  const spelling = beginSpelling();
  assert.equal(
    reviewReducer(spelling, { type: 'input', wordId: 'unrelated', value: 'x' }),
    spelling,
  );
  assert.equal(reviewReducer(spelling, { type: 'acknowledge', wordId: 'apple' }), spelling);
});

test('empty review has no batch to submit and the first visible stage is learning', () => {
  const state = createReviewState([]);
  assert.equal(state.phase, 'complete');
  assert.equal(canSubmitRound(state), false);
  assert.deepEqual(
    getSessionStages(state.words.length > 0).map((stage) => stage.id),
    ['learn', 'practice', 'summary'],
  );
  assert.equal(getSessionStages(demoReviewWords.length > 0)[0]?.id, 'review');
});
