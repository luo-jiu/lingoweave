/**
 * Public fixtures for the explicitly labelled, frontend-only study prototype.
 * These are not a learner's data or private examination answers. Word senses
 * and IPA follow the project's seed glossary; see docs/lexicon-sources.md.
 * Adapted lexical data: Wiktionary contributors, CC BY-SA 4.0.
 * Chinese glosses are project edits; IPA follows the linked revisions.
 * Examples below are hand-written demo content, not a live Agent's output.
 */
export interface DemoWord {
  id: string;
  english: string;
  meaning: string;
  ipa: string;
  partOfSpeech: string;
  example: string;
  translation: string;
  source: {
    name: string;
    url: string;
    license: string;
    version: string;
  };
}

function wordSource(english: string, revision: number): DemoWord['source'] {
  return {
    name: 'Wiktionary contributors',
    url: `https://en.wiktionary.org/w/index.php?title=${english}&oldid=${revision}#English`,
    license: 'CC BY-SA 4.0',
    version: `Wiktionary revision ${revision}; LingoWeave seed v1, 2026-11-03`,
  };
}

export const demoReviewWords: readonly DemoWord[] = [
  {
    id: 'apple',
    source: wordSource('apple', 94495227),
    english: 'apple',
    meaning: '苹果（水果）',
    ipa: '/ˈæpəl/',
    partOfSpeech: 'n.',
    example: 'I have an apple.',
    translation: '我有一个苹果。',
  },
  {
    id: 'book',
    source: wordSource('book', 94548435),
    english: 'book',
    meaning: '书；书本',
    ipa: '/bʊk/',
    partOfSpeech: 'n.',
    example: 'This is my book.',
    translation: '这是我的书。',
  },
  {
    id: 'water',
    source: wordSource('water', 95210102),
    english: 'water',
    meaning: '水',
    ipa: '/ˈwɔː.tə/',
    partOfSpeech: 'n.',
    example: 'I drink water.',
    translation: '我喝水。',
  },
  {
    id: 'read',
    source: wordSource('read', 94584767),
    english: 'read',
    meaning: '阅读；看懂文字',
    ipa: '/ɹiːd/',
    partOfSpeech: 'v.',
    example: 'I read a book.',
    translation: '我读一本书。',
  },
  {
    id: 'write',
    source: wordSource('write', 93802082),
    english: 'write',
    meaning: '写；书写文字',
    ipa: '/ɹaɪt/',
    partOfSpeech: 'v.',
    example: 'I write my name.',
    translation: '我写下我的名字。',
  },
];

export const demoLearningWords: readonly DemoWord[] = [
  {
    id: 'house',
    source: wordSource('house', 94898383),
    english: 'house',
    meaning: '房屋；住宅',
    ipa: '/haʊ̯s/',
    partOfSpeech: 'n.',
    example: 'This is my house.',
    translation: '这是我的房子。',
  },
  {
    id: 'room',
    source: wordSource('room', 94570303),
    english: 'room',
    meaning: '房间',
    ipa: '/ɹuːm/',
    partOfSpeech: 'n.',
    example: 'My room is small.',
    translation: '我的房间很小。',
  },
  {
    id: 'door',
    source: wordSource('door', 93758937),
    english: 'door',
    meaning: '门',
    ipa: '/dɔː/',
    partOfSpeech: 'n.',
    example: 'The door is open.',
    translation: '门开着。',
  },
  {
    id: 'chair',
    source: wordSource('chair', 93683967),
    english: 'chair',
    meaning: '椅子',
    ipa: '/t͡ʃɛə/',
    partOfSpeech: 'n.',
    example: 'This is a chair.',
    translation: '这是一把椅子。',
  },
  {
    id: 'table',
    source: wordSource('table', 93429919),
    english: 'table',
    meaning: '桌子',
    ipa: '/ˈteɪbl̩/',
    partOfSpeech: 'n.',
    example: 'The book is on the table.',
    translation: '书在桌子上。',
  },
];

export type ReviewRating = 'forgotten' | 'fuzzy' | 'clear';
export const reviewRatingOptions: readonly { value: ReviewRating; label: string; hint: string }[] =
  [
    { value: 'forgotten', label: '遗忘', hint: '想不起来，或想错了' },
    { value: 'fuzzy', label: '模糊', hint: '想了一会儿，或不确定' },
    { value: 'clear', label: '清晰', hint: '很快、确定地想起来' },
  ];
export type ReviewPhase = 'recall' | 'spelling' | 'correction' | 'complete';

export interface ReviewAttempt {
  wordId: string;
  /** Original text is retained, including surrounding whitespace and case. */
  answer: string;
  unknown: boolean;
  correct: boolean;
}

export interface ReviewRound {
  number: number;
  attempts: readonly ReviewAttempt[];
}

export interface ReviewState {
  words: readonly DemoWord[];
  phase: ReviewPhase;
  ratings: Readonly<Record<string, ReviewRating | undefined>>;
  activeIds: readonly string[];
  inputs: Readonly<Record<string, string | undefined>>;
  unknownIds: readonly string[];
  passedIds: readonly string[];
  deferredIds: readonly string[];
  acknowledgedIds: readonly string[];
  rounds: readonly ReviewRound[];
  paused: boolean;
}

export type ReviewAction =
  | { type: 'rate'; wordId: string; rating: ReviewRating }
  | { type: 'start-spelling' }
  | { type: 'input'; wordId: string; value: string }
  | { type: 'unknown'; wordId: string; value: boolean }
  | { type: 'submit' }
  | { type: 'acknowledge'; wordId: string }
  | { type: 'next-round' }
  | { type: 'defer'; wordId: string }
  | { type: 'pause' }
  | { type: 'resume' };

export function createReviewState(words: readonly DemoWord[] = demoReviewWords): ReviewState {
  return {
    words,
    phase: words.length === 0 ? 'complete' : 'recall',
    ratings: {},
    activeIds: words.map((word) => word.id),
    inputs: {},
    unknownIds: [],
    passedIds: [],
    deferredIds: [],
    acknowledgedIds: [],
    rounds: [],
    paused: false,
  };
}

export function canStartSpelling(state: ReviewState): boolean {
  return (
    !state.paused &&
    state.phase === 'recall' &&
    state.activeIds.every((id) => state.ratings[id] !== undefined)
  );
}

export function canSubmitRound(state: ReviewState): boolean {
  return (
    !state.paused &&
    state.phase === 'spelling' &&
    state.activeIds.length > 0 &&
    state.activeIds.every(
      (id) => state.unknownIds.includes(id) || Boolean(state.inputs[id]?.trim()),
    )
  );
}

export function canStartNextRound(state: ReviewState): boolean {
  return (
    !state.paused &&
    state.phase === 'correction' &&
    state.activeIds.length > 0 &&
    state.activeIds.every((id) => state.acknowledgedIds.includes(id))
  );
}

/** Deterministic shuffle keeps this demo reducer pure and retryable. */
function shuffleRemaining(ids: readonly string[], round: number): string[] {
  const shuffled = [...ids];
  let seed = round * 2654435761;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const other = seed % (index + 1);
    const currentValue = shuffled[index];
    const otherValue = shuffled[other];
    if (currentValue !== undefined && otherValue !== undefined) {
      shuffled[index] = otherValue;
      shuffled[other] = currentValue;
    }
  }
  if (shuffled.length > 1 && shuffled.every((id, index) => id === ids[index])) {
    const first = shuffled.shift();
    if (first !== undefined) shuffled.push(first);
  }
  return shuffled;
}

export function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  if (action.type === 'pause') return { ...state, paused: true };
  if (action.type === 'resume') return { ...state, paused: false };
  if (state.paused) return state;

  switch (action.type) {
    case 'rate': {
      if (state.phase !== 'recall' || !state.activeIds.includes(action.wordId)) return state;
      const ratings = { ...state.ratings };
      if (ratings[action.wordId] === action.rating) delete ratings[action.wordId];
      else ratings[action.wordId] = action.rating;
      return { ...state, ratings };
    }
    case 'start-spelling':
      return canStartSpelling(state) ? { ...state, phase: 'spelling' } : state;
    case 'input':
      if (state.phase !== 'spelling' || !state.activeIds.includes(action.wordId)) return state;
      return {
        ...state,
        inputs: { ...state.inputs, [action.wordId]: action.value },
        unknownIds: state.unknownIds.filter((id) => id !== action.wordId),
      };
    case 'unknown':
      if (state.phase !== 'spelling' || !state.activeIds.includes(action.wordId)) return state;
      return {
        ...state,
        unknownIds: action.value
          ? [...new Set([...state.unknownIds, action.wordId])]
          : state.unknownIds.filter((id) => id !== action.wordId),
      };
    case 'submit': {
      if (!canSubmitRound(state)) return state;
      const attempts = state.activeIds.map((wordId): ReviewAttempt => {
        const word = state.words.find((candidate) => candidate.id === wordId);
        const answer = state.inputs[wordId] ?? '';
        const unknown = state.unknownIds.includes(wordId);
        return {
          wordId,
          answer,
          unknown,
          correct:
            !unknown &&
            word !== undefined &&
            answer.trim().toLowerCase() === word.english.toLowerCase(),
        };
      });
      const failed = attempts
        .filter((attempt) => !attempt.correct)
        .map((attempt) => attempt.wordId);
      return {
        ...state,
        phase: failed.length === 0 ? 'complete' : 'correction',
        activeIds: failed,
        passedIds: [
          ...state.passedIds,
          ...attempts.filter((attempt) => attempt.correct).map((attempt) => attempt.wordId),
        ],
        acknowledgedIds: [],
        rounds: [...state.rounds, { number: state.rounds.length + 1, attempts }],
      };
    }
    case 'acknowledge':
      if (state.phase !== 'correction' || !state.activeIds.includes(action.wordId)) return state;
      return { ...state, acknowledgedIds: [...new Set([...state.acknowledgedIds, action.wordId])] };
    case 'next-round':
      if (!canStartNextRound(state)) return state;
      return {
        ...state,
        phase: 'spelling',
        activeIds: shuffleRemaining(state.activeIds, state.rounds.length + 1),
        inputs: {},
        unknownIds: [],
        acknowledgedIds: [],
      };
    case 'defer': {
      if (state.phase !== 'correction' || !state.activeIds.includes(action.wordId)) return state;
      const activeIds = state.activeIds.filter((id) => id !== action.wordId);
      return {
        ...state,
        activeIds,
        phase: activeIds.length === 0 ? 'complete' : 'correction',
        deferredIds: [...state.deferredIds, action.wordId],
        acknowledgedIds: state.acknowledgedIds.filter((id) => id !== action.wordId),
      };
    }
  }
}

export type SessionStageId = 'review' | 'learn' | 'practice' | 'summary';

export interface SessionStage {
  id: SessionStageId;
  label: string;
}

export function getSessionStages(hasReview: boolean): SessionStage[] {
  return [
    ...(hasReview ? [{ id: 'review' as const, label: '复习' }] : []),
    { id: 'learn', label: '学习' },
    { id: 'practice', label: '句子练习' },
    { id: 'summary', label: '小结' },
  ];
}
