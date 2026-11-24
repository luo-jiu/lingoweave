import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { miniCommandSchema } from '@lingoweave/contracts';
import { MiniStore } from './mini-store.js';
import { swiftTime } from './mini-study.js';

const timezone = 'Asia/Shanghai';
const words = [
  { spelling: 'apple', meaning: '苹果', phonetic: '' },
  { spelling: 'book', meaning: '书', phonetic: '' },
];

for (const reason of ['budget', 'manual'] as const) {
  test(`version 7 removes minute settings and ${reason === 'budget' ? 'resumes a timed pause' : 'preserves an intentional pause'}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lingoweave-remove-time-'));
    const file = join(directory, 'mini.sqlite');
    const start = new Date('2026-11-17T02:00:00Z');
    let store = new MiniStore(file, { now: () => start, timezone });
    try {
      store.importLegacy({
        requestId: randomUUID(),
        ledger: { days: [] },
        reviewRecord: null,
        reviewHistory: [],
        timezone,
      });
      store.command({
        requestId: randomUUID(),
        expectedRevision: store.snapshot().revision,
        action: {
          type: 'begin',
          target: 'daily',
          deck: words,
          timezone,
          flowVersion: 'sliding-window-v2',
        },
      });
      const saved = store.snapshot();
      const endedAt = swiftTime(start) + 90;
      const legacy = {
        ...saved,
        ledger: {
          days: saved.ledger.days.map((day) => ({
            ...day,
            paused: true,
            pauseEvents: [{ paused: true, at: endedAt }],
          })),
        },
        planning: {
          ...saved.planning,
          longTerm: { ...saved.planning.longTerm, minutes: 1 },
          sessions: saved.planning.sessions.map((session) => ({
            ...session,
            minutes: 1,
            endedAt,
            pauseReason: reason,
          })),
          nextSessionOverride: { wordLimit: 10, newWordLimit: 5, minutes: 1 },
        },
      };
      store.close();
      const db = new DatabaseSync(file);
      db.prepare('UPDATE mini_state SET body = ? WHERE id = 1').run(JSON.stringify(legacy));
      db.exec('PRAGMA user_version = 7');
      db.close();
      store = new MiniStore(file, { now: () => new Date(start.getTime() + 2 * 3600000), timezone });
      const migrated = store.snapshot();
      assert.equal(migrated.ledger.days[0]?.paused, reason === 'manual');
      assert.deepEqual(migrated.ledger.days[0]?.flow, saved.ledger.days[0]?.flow);
      assert.deepEqual(migrated.ledger.days[0]?.translation, saved.ledger.days[0]?.translation);
      assert.equal(JSON.stringify(migrated.planning).includes('minutes'), false);
      const raw = new DatabaseSync(file, { readOnly: true });
      assert.equal(
        JSON.stringify(raw.prepare('SELECT body FROM mini_state').get()).includes('minutes'),
        false,
      );
      assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 13);
      raw.close();
      store.close();
      store = new MiniStore(file, { now: () => start, timezone });
      assert.deepEqual(
        store.snapshot(),
        migrated,
        'Reopening cannot repeat the migration or resume a manual pause',
      );
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('legacy pending plans discard minutes while new contracts expose only word settings', () => {
  const store = new MiniStore(':memory:');
  try {
    store.importLegacy({
      requestId: randomUUID(),
      ledger: { days: [] },
      reviewRecord: null,
      reviewHistory: [],
      timezone,
    });
    const old = {
      requestId: randomUUID(),
      expectedRevision: store.snapshot().revision,
      action: {
        type: 'set_long_term_plan' as const,
        target: 'daily' as const,
        plan: {
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          wordLimit: 10,
          newWordLimit: 5,
          minutes: 20,
          dailyNewGoal: 20,
          groupSize: 10,
        },
      },
    };
    assert.equal(miniCommandSchema.safeParse(old).success, false);
    const result = store.command(old);
    assert.equal(result.planning.longTerm.dailyNewGoal, 20);
    assert.equal('minutes' in result.planning.longTerm, false);
  } finally {
    store.close();
  }
});
