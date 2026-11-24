import { randomInt } from 'node:crypto';
import type { MiniReviewSession, MiniWord } from '@lingoweave/contracts';
import { LearningError } from './learning-store.js';

type RoundOrders = NonNullable<MiniReviewSession['spellingRounds']>;

// The window's last input already has a random UUID. Using its first 32 bits
// lets the native card display the same first spelling prompt before the receipt.
function seededIndex(seed: string) {
  let state = Number.parseInt(seed.slice(0, 8), 16) || 1;
  return (min: number, max: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return min + ((state >>> 0) % (max - min));
  };
}

// Only the spelling queue is permuted. The group's words and translation assignments keep
// their original order. Persisting each permutation also keeps historical replay independent of RNG.
export function startSpellingRound(
  session: MiniReviewSession,
  candidates: MiniWord[],
  round: number,
  replay?: RoundOrders,
  seed?: string,
) {
  session.phase = candidates.length ? 'spelling' : 'finished';
  session.queue = [...candidates];
  session.spellingDraft = '';
  if (candidates.length < 2) return;

  let order = replay?.find((item) => item.round === round)?.order;
  if (replay && !order) return; // This round started before shuffled orders were recorded.
  if (!order) {
    const draw = seed ? seededIndex(seed) : randomInt;
    order = candidates.map((_, index) => index);
    for (let i = 0; i < order.length - 1; i++) {
      // Start with a different word even for short groups, then shuffle the remaining suffix.
      const j = draw(i === 0 ? 1 : i, order.length);
      const left = order[i];
      const right = order[j];
      if (left === undefined || right === undefined) throw new RangeError('Invalid shuffle index');
      order[i] = right;
      order[j] = left;
    }
  }
  if (order.length !== candidates.length || new Set(order).size !== candidates.length)
    throw new LearningError('MINI_STATE_CONFLICT', '拼写轮次与本轮目标不一致。');
  session.queue = order.map((index) => {
    const word = candidates[index];
    if (!word) throw new LearningError('MINI_STATE_CONFLICT', '拼写轮次包含未知目标。');
    return word;
  });
  (session.spellingRounds ??= []).push({ round, order: [...order] });
}
