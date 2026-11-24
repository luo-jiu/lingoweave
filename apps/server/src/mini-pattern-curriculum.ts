import type { MiniPatternCard, MiniPatternLevel } from '@lingoweave/contracts';

type Entry = { card: MiniPatternCard; cost: number; references: string[] };
function entry(
  id: string,
  level: MiniPatternLevel,
  cost: number,
  frame: string,
  meaning: string,
  example: string,
  translation: string,
  cue: string,
  substitution: string,
  ...references: string[]
): Entry {
  return {
    card: { id, level, frame, meaning, example, translation, cue, substitution },
    cost,
    references,
  };
}

// Stable exercise IDs bind saved attempts to the exact prompt. Give changed exercises new IDs.
export const patternCurriculum = [
  entry(
    'a1-need',
    'A1',
    1,
    'I need …',
    '我需要……',
    'I need a bag.',
    '我需要一个包。',
    '我需要一支笔。',
    'a pen',
    'I need a pen.',
  ),
  entry(
    'a1-have',
    'A1',
    1,
    'I have …',
    '我有……',
    'I have a book.',
    '我有一本书。',
    '我有一个包。',
    'a bag',
    'I have a bag.',
  ),
  entry(
    'a1-like',
    'A1',
    1,
    'I like …',
    '我喜欢……',
    'I like music.',
    '我喜欢音乐。',
    '我喜欢茶。',
    'tea',
    'I like tea.',
  ),
  entry(
    'a1-name',
    'A1',
    1,
    'My name is …',
    '我的名字是……',
    'My name is Sam.',
    '我叫山姆。',
    '我叫安娜。',
    'Anna',
    'My name is Anna.',
    "My name's Anna.",
  ),
  entry(
    'a1-live',
    'A1',
    1,
    'I live in …',
    '我住在……',
    'I live in London.',
    '我住在伦敦。',
    '我住在上海。',
    'Shanghai',
    'I live in Shanghai.',
  ),
  entry(
    'a1-location',
    'A1',
    2,
    'Where is …?',
    '……在哪里？',
    'Where is my book?',
    '我的书在哪里？',
    '我的包在哪里？',
    'my bag',
    'Where is my bag?',
    "Where's my bag?",
  ),
  entry(
    'a1-identify',
    'A1',
    1,
    'Is this …?',
    '这是……吗？',
    'Is this your pen?',
    '这是你的笔吗？',
    '这是你的书吗？',
    'your book',
    'Is this your book?',
  ),
  entry(
    'a1-ask-have',
    'A1',
    2,
    'Do you have …?',
    '你有……吗？',
    'Do you have a pen?',
    '你有一支笔吗？',
    '你有一张票吗？',
    'a ticket',
    'Do you have a ticket?',
  ),
  entry(
    'a1-request',
    'A1',
    3,
    'Can I have …, please?',
    '可以给我……吗？',
    'Can I have some water, please?',
    '可以给我一些水吗？',
    '可以给我一些茶吗？',
    'some tea',
    'Can I have some tea, please?',
    'Can I please have some tea?',
    'Please can I have some tea?',
  ),
  entry(
    'a1-directions',
    'A1',
    3,
    'How do I get to …?',
    '去……怎么走？',
    'How do I get to the park?',
    '去公园怎么走？',
    '去车站怎么走？',
    'the station',
    'How do I get to the station?',
  ),
  entry(
    'a2-plan',
    'A2',
    3,
    'I’m going to …',
    '我打算……',
    'I’m going to make dinner.',
    '我打算做晚饭。',
    '我打算读这本书。',
    'read this book',
    'I’m going to read this book.',
    'I am going to read this book.',
  ),
  entry(
    'a2-reason',
    'A2',
    3,
    'I like … because …',
    '我喜欢……，因为……',
    'I like tea because it is hot.',
    '我喜欢茶，因为它是热的。',
    '我喜欢这本书，因为它很有趣。',
    'this book / it is interesting',
    'I like this book because it is interesting.',
    'I like this book because it’s interesting.',
  ),
];

export function patternBatch(
  level: MiniPatternLevel,
  completed: Set<string>,
  limit: number,
): MiniPatternCard[] {
  const cards: MiniPatternCard[] = [];
  let cost = 0;
  for (const entry of patternCurriculum) {
    if (entry.card.level !== level || completed.has(entry.card.id)) continue;
    if (cards.length >= limit || (cards.length >= 2 && cost + entry.cost > 5)) break;
    cards.push(entry.card);
    cost += entry.cost;
  }
  return cards;
}

export function normalizedSubstitution(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/gu, "'")
    .replace(/[.,!?，。！？“”"]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}
