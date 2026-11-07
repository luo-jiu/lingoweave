import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createThemeStore,
  type ResolvedTheme,
  type ThemeEnvironment,
  type ThemePreference,
} from '../src/lib/theme.ts';

function createEnvironment(stored: string | null = null, dark = false) {
  const applied: ResolvedTheme[] = [];
  const saved: ThemePreference[] = [];
  const systemListeners: (() => void)[] = [];
  const storageListeners: ((value: string | null) => void)[] = [];
  const environment: ThemeEnvironment = {
    readPreference: () => stored,
    writePreference: (preference) => saved.push(preference),
    isSystemDark: () => dark,
    applyTheme: (theme) => applied.push(theme),
    subscribeToSystemChange: (listener) => systemListeners.push(listener),
    subscribeToStorageChange: (listener) => storageListeners.push(listener),
  };
  return {
    environment,
    applied,
    saved,
    systemListeners,
    storageListeners,
    systemChangesTo(value: boolean) {
      dark = value;
      systemListeners.forEach((listener) => listener());
    },
    storageChangesTo(value: string | null) {
      storageListeners.forEach((listener) => listener(value));
    },
  };
}

test('initialization follows the system immediately and installs listeners only once', () => {
  const store = createThemeStore();
  const env = createEnvironment(null, true);
  assert.equal(store.getSnapshot(), 'system');
  assert.equal(store.getServerSnapshot(), 'system');
  assert.deepEqual(env.applied, []);

  store.initialize(env.environment);
  store.initialize(env.environment);
  assert.deepEqual(env.applied, ['dark']);
  assert.equal(env.systemListeners.length, 1);
  assert.equal(env.storageListeners.length, 1);

  env.systemChangesTo(false);
  assert.deepEqual(env.applied, ['dark', 'light']);
  assert.deepEqual(env.saved, []);
});

test('explicit choices persist, override system changes, and can return to following the system', () => {
  const store = createThemeStore();
  const env = createEnvironment();
  store.initialize(env.environment);
  store.setPreference('dark');
  env.systemChangesTo(true);
  env.systemChangesTo(false);
  assert.equal(store.getSnapshot(), 'dark');
  assert.deepEqual(env.applied, ['light', 'dark']);

  store.setPreference('system');
  env.systemChangesTo(true);
  assert.equal(store.getSnapshot(), 'system');
  assert.deepEqual(env.applied, ['light', 'dark', 'light', 'dark']);
  assert.deepEqual(env.saved, ['dark', 'system']);
});

test('valid stored choices restore and invalid preferences fall back to the system', () => {
  for (const value of ['light', 'dark', 'system', 'invalid', '']) {
    const store = createThemeStore();
    const env = createEnvironment(value, true);
    store.initialize(env.environment);
    assert.equal(store.getSnapshot(), value === 'light' || value === 'dark' ? value : 'system');
    assert.deepEqual(env.applied, [value === 'light' ? 'light' : 'dark']);
    assert.deepEqual(env.saved, []);
  }
});

test('disabled storage falls back to the system without blocking later page choices', () => {
  const store = createThemeStore();
  const env = createEnvironment(null, true);
  env.environment.readPreference = () => {
    throw new Error('Storage is disabled');
  };
  env.environment.writePreference = () => {
    throw new Error('Storage is disabled');
  };
  store.initialize(env.environment);
  assert.equal(store.getSnapshot(), 'system');
  store.setPreference('light');
  assert.equal(store.getSnapshot(), 'light');
  assert.deepEqual(env.applied, ['dark', 'light']);
});

test('cross-tab changes notify subscribers and deletion or invalid values restore system mode', () => {
  const store = createThemeStore();
  const env = createEnvironment('light', true);
  store.initialize(env.environment);
  const snapshots: ThemePreference[] = [];
  const unsubscribe = store.subscribe(() => snapshots.push(store.getSnapshot()));
  env.storageChangesTo('dark');
  env.storageChangesTo('dark');
  env.storageChangesTo(null);
  env.systemChangesTo(false);
  env.storageChangesTo('light');
  env.storageChangesTo('invalid');
  assert.deepEqual(snapshots, ['dark', 'system', 'light', 'system']);
  assert.deepEqual(env.saved, []);
  assert.equal(env.applied.at(-1), 'light');

  unsubscribe();
  env.storageChangesTo('dark');
  assert.deepEqual(snapshots, ['dark', 'system', 'light', 'system']);
});
