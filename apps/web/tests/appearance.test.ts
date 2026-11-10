import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAppearanceStore, type AppearanceEnvironment } from '../src/lib/appearance.ts';

function createEnvironment(stored: string | null = null) {
  const applied: boolean[] = [];
  const saved: boolean[] = [];
  const storageListeners: ((value: string | null) => void)[] = [];
  const environment: AppearanceEnvironment = {
    readCompact: () => stored,
    writeCompact: (compact) => saved.push(compact),
    applyCompact: (compact) => applied.push(compact),
    subscribeToStorageChange: (listener) => storageListeners.push(listener),
  };
  return {
    environment,
    applied,
    saved,
    storageListeners,
    storageChangesTo(value: string | null) {
      storageListeners.forEach((listener) => listener(value));
    },
  };
}

test('the full interface is the default and initialization installs one storage listener', () => {
  const store = createAppearanceStore();
  const env = createEnvironment();
  assert.equal(store.getSnapshot(), false);
  assert.equal(store.getServerSnapshot(), false);
  assert.deepEqual(env.applied, []);

  store.initialize(env.environment);
  store.initialize(env.environment);
  assert.deepEqual(env.applied, [false]);
  assert.equal(env.storageListeners.length, 1);
  assert.deepEqual(env.saved, []);
});

test('only the true string restores compact mode', () => {
  for (const value of ['true', 'false', 'invalid', 'TRUE', '1', '', null]) {
    const store = createAppearanceStore();
    const env = createEnvironment(value);
    store.initialize(env.environment);
    assert.equal(store.getSnapshot(), value === 'true');
    assert.deepEqual(env.applied, [value === 'true']);
    assert.deepEqual(env.saved, []);
  }
});

test('explicit choices persist and subscribers receive changes until unsubscribed', () => {
  const store = createAppearanceStore();
  const env = createEnvironment();
  store.initialize(env.environment);
  const snapshots: boolean[] = [];
  const unsubscribe = store.subscribe(() => snapshots.push(store.getSnapshot()));

  store.setCompact(true);
  store.setCompact(true);
  store.setCompact(false);
  assert.deepEqual(env.saved, [true, true, false]);
  assert.deepEqual(snapshots, [true, false]);
  unsubscribe();
  store.setCompact(true);
  assert.deepEqual(snapshots, [true, false]);
});

test('disabled storage preserves the full default without preventing page choices', () => {
  const store = createAppearanceStore();
  const env = createEnvironment('true');
  env.environment.readCompact = () => {
    throw new Error('Storage is disabled');
  };
  env.environment.writeCompact = () => {
    throw new Error('Storage is disabled');
  };

  store.initialize(env.environment);
  assert.equal(store.getSnapshot(), false);
  store.setCompact(true);
  assert.equal(store.getSnapshot(), true);
  assert.deepEqual(env.applied, [false, true]);
});

test('cross-tab choices synchronize while removal, clear, or invalid values restore the full mode', () => {
  const store = createAppearanceStore();
  const env = createEnvironment('true');
  store.initialize(env.environment);
  const snapshots: boolean[] = [];
  store.subscribe(() => snapshots.push(store.getSnapshot()));

  env.storageChangesTo('false');
  env.storageChangesTo('true');
  env.storageChangesTo(null);
  env.storageChangesTo('true');
  env.storageChangesTo('invalid');
  env.storageChangesTo(null);
  assert.equal(store.getSnapshot(), false);
  assert.deepEqual(snapshots, [false, true, false, true, false]);
  assert.deepEqual(env.saved, []);
});
