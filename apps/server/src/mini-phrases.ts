import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  miniPhraseQuerySchema,
  type MiniPhraseEntry,
  type MiniPhraseQuery,
  type MiniPhrasePage,
  type MiniSentence,
  type MiniSnapshot,
  type MiniWord,
} from '@lingoweave/contracts';
import { z } from 'zod';
import { patternCurriculum } from './mini-pattern-curriculum.js';
import { swiftTime, wordKey } from './mini-study.js';

function searchable(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘]/gu, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim();
}
const patternHistoryRow = z.object({
  pattern_id: z.string(),
  at_ms: z.number(),
  status: z.enum(['viewed', 'attempted', 'practiced']),
});
const assessmentPhrase = z.object({
  expression: z.string(),
  explanation: z.string(),
  word: z.string(),
  assessed_at: z.number(),
});
type Phrase = Omit<MiniPhraseEntry, 'id'>;
const noExample = { exampleEnglish: null, exampleChinese: null };

function exampleOf(expression: string, sentence: MiniSentence) {
  // Some feedback suggests wording different from the original exercise.
  if (!(' ' + searchable(sentence.english) + ' ').includes(' ' + searchable(expression) + ' '))
    return noExample;
  return { exampleEnglish: sentence.english, exampleChinese: sentence.chinese };
}
function legacyPhrase(text: string) {
  const bilingual = /^([^\p{Script=Han}·]+?)\s+·\s+(.*\p{Script=Han}.*)$/u.exec(text);
  if (bilingual?.[1] && bilingual[2])
    return { expression: bilingual[1].trim(), explanation: bilingual[2].trim() };
  return { expression: text, explanation: null };
}

function phraseKey(entry: Phrase) {
  return JSON.stringify([
    entry.kind,
    searchable(entry.expression),
    searchable(entry.explanation ?? ''),
  ]);
}

function withId(entry: Phrase, key: string): MiniPhraseEntry {
  return { ...entry, id: entry.kind + '-' + createHash('sha256').update(key).digest('hex') };
}

function recentlySeenFirst(a: MiniPhraseEntry, b: MiniPhraseEntry) {
  return b.lastSeenAt - a.lastSeenAt || a.id.localeCompare(b.id);
}

export function collectMiniPatternPhrases(db: DatabaseSync) {
  const history = db
    .prepare(
      `
    SELECT pattern_id, MAX(at_ms) AS at_ms,
      CASE MAX(progress) WHEN 2 THEN 'practiced' WHEN 1 THEN 'attempted' ELSE 'viewed' END AS status
    FROM (
      SELECT pattern_id, at_ms, 0 AS progress FROM mini_pattern_views
      UNION ALL
      SELECT pattern_id, at_ms, 1 + completed AS progress FROM mini_pattern_attempts
    ) GROUP BY pattern_id`,
    )
    .all();
  const patterns: MiniPhraseEntry[] = [];
  for (const raw of history) {
    const row = patternHistoryRow.parse(raw);
    const card = patternCurriculum.find((entry) => entry.card.id === row.pattern_id)?.card;
    if (card) {
      const entry: Phrase = {
        kind: 'pattern',
        status: row.status,
        expression: card.frame,
        explanation: card.meaning,
        exampleEnglish: card.example,
        exampleChinese: card.translation,
        words: [],
        lastSeenAt: swiftTime(new Date(row.at_ms)),
      };
      patterns.push(withId(entry, phraseKey(entry)));
    }
  }
  return patterns.sort(recentlySeenFirst);
}

export function collectMiniPhrases(
  db: DatabaseSync,
  state: MiniSnapshot,
  audio: { sentence: MiniSentence; at: number }[] = [],
) {
  const result = new Map<string, MiniPhraseEntry>();
  function add(entry: Phrase) {
    if (!searchable(entry.expression)) return;
    // Keep different meanings and source categories discoverable; repeated encounters
    // of the same expression within that category share one row.
    const key = phraseKey(entry);
    const prior = result.get(key);
    if (prior) {
      const words = [...new Set([...prior.words, ...entry.words])];
      const example = entry.exampleEnglish !== null ? entry : prior;
      const { exampleEnglish, exampleChinese } = example;
      if (entry.lastSeenAt > prior.lastSeenAt) Object.assign(prior, entry);
      if (prior.exampleEnglish === null) Object.assign(prior, { exampleEnglish, exampleChinese });
      prior.words = words;
    } else {
      result.set(key, withId(entry, key));
    }
  }
  const focusVisits = new Map<string, { at: number; sentence?: MiniSentence }>();
  function sawFocus(id: string, at: number, sentence?: MiniSentence) {
    const previous = focusVisits.get(id);
    focusVisits.set(id, {
      at: Math.max(previous?.at ?? at, at),
      sentence: sentence ?? previous?.sentence,
    });
  }
  function sawSentence(
    word: MiniWord,
    sentence: Pick<MiniSentence, 'english' | 'chinese'>,
    at: number,
  ) {
    add({
      kind: 'sentence',
      status: 'encountered',
      expression: sentence.english,
      explanation: sentence.chinese,
      ...noExample,
      words: [word.spelling],
      lastSeenAt: at,
    });
  }
  for (const exposure of state.teaching.exposures) {
    for (const id of exposure.focusIds) sawFocus(id, exposure.at);
    if (exposure.visibleSentence) sawSentence(exposure.word, exposure.visibleSentence, exposure.at);
  }
  for (const { sentence, at } of audio) sawSentence(sentence.word, sentence, at);
  for (const day of state.ledger.days) {
    const sentences = new Map(day.sentences.map((s) => [wordKey(s.word), s]));
    function sawCard(word: MiniWord, at: number) {
      const sentence = sentences.get(wordKey(word));
      if (sentence) sawSentence(word, sentence, at);
    }
    // Older clients did not name the displayed example in their card-view command.
    // Recover only presentations confirmed by actions on a card in this same group.
    for (const mark of day.studiedWords) sawCard(mark.word, mark.at);
    for (const mark of day.studyMarkEvents ?? []) sawCard(mark.word, mark.at);
    for (const round of day.memory?.events ?? []) {
      if (round.round <= 2) sawCard(round.word, round.at);
    }
    for (const reveal of day.memory?.reveals ?? []) sawCard(reveal.word, reveal.at);
    for (const window of [day.flow?.window, day.review?.relearning]) {
      for (const event of window?.events ?? []) sawCard(event.word, event.confirmedAt);
      if (window?.visit?.revealedAt !== undefined)
        sawCard(window.visit.word, window.visit.revealedAt);
    }
    for (const judgment of day.review?.judgmentEvents ?? [])
      sawCard(judgment.word, judgment.selectedAt);
    for (const judgment of day.review?.clearedJudgments ?? [])
      sawCard(judgment.word, judgment.selectedAt);
    for (const attempt of day.translation) {
      const sentence = attempt.task.sentence;
      if (
        attempt.task.direction === 'englishToChinese' ||
        (searchable(attempt.answer) !== '' &&
          searchable(attempt.answer) === searchable(sentence.english))
      )
        sawSentence(sentence.word, sentence, attempt.submittedAt);
      for (const id of attempt.task.focusIds ?? []) sawFocus(id, attempt.submittedAt, sentence);
      const phrase = attempt.feedback?.usefulPhrase.trim();
      if (phrase) {
        const saved = legacyPhrase(phrase);
        add({
          kind: 'feedback',
          status: 'feedback',
          ...saved,
          ...exampleOf(saved.expression, sentence),
          words: [sentence.word.spelling],
          lastSeenAt: attempt.gradedAt ?? attempt.submittedAt,
        });
      }
    }
  }
  for (const focus of state.teaching.focusItems) {
    const visit = focusVisits.get(focus.id);
    if (!visit) continue;
    add({
      kind: 'focus',
      status: 'encountered',
      expression: focus.expression,
      explanation: focus.explanation,
      ...(visit.sentence ? exampleOf(focus.expression, visit.sentence) : noExample),
      words: focus.words.map((w) => w.spelling),
      lastSeenAt: visit.at,
    });
  }
  // Modern assessments persist the structured suggestion with the original receipt.
  // Older assessments without it contain free-form feedback; don't guess a phrase from it.
  const assessed = db
    .prepare(
      `
    SELECT json_extract(application,'$.result.reusablePhrase.expression') AS expression,
           json_extract(application,'$.result.reusablePhrase.explanation') AS explanation,
           json_extract(application,'$.source.word.spelling') AS word,
           json_extract(application,'$.trace.assessedAt') AS assessed_at
    FROM mini_assessment_records WHERE json_type(application,'$.result.reusablePhrase')='object'`,
    )
    .all();
  for (const raw of assessed) {
    const row = assessmentPhrase.parse(raw);
    add({
      kind: 'feedback',
      status: 'feedback',
      expression: row.expression,
      explanation: row.explanation,
      ...noExample,
      words: [row.word],
      lastSeenAt: row.assessed_at,
    });
  }
  return [...collectMiniPatternPhrases(db), ...result.values()].sort(recentlySeenFirst);
}

export function searchMiniPhrases(
  entries: MiniPhraseEntry[],
  query: MiniPhraseQuery,
): MiniPhrasePage {
  const { q, kind, offset, limit } = miniPhraseQuerySchema.parse(query);
  const terms = searchable(q).split(' ').filter(Boolean);
  const filtered = entries.filter((entry) => {
    if (kind && entry.kind !== kind) return false;
    if (!terms.length) return true;
    const text = searchable(
      [
        entry.expression,
        entry.explanation,
        entry.exampleEnglish,
        entry.exampleChinese,
        ...entry.words,
      ].join(' '),
    );
    return terms.every((term) => text.includes(term));
  });
  return { total: filtered.length, items: filtered.slice(offset, offset + limit) };
}
