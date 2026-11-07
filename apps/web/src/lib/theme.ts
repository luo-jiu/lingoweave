export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const themeStorageKey = 'lingoweave.theme';

export interface ThemeEnvironment {
  readPreference(): string | null;
  writePreference(preference: ThemePreference): void;
  isSystemDark(): boolean;
  applyTheme(theme: ResolvedTheme): void;
  subscribeToSystemChange(listener: () => void): void;
  subscribeToStorageChange(listener: (value: string | null) => void): void;
}

function parsePreference(value: string | null): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

function browserEnvironment(): ThemeEnvironment {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  return {
    readPreference: () => window.localStorage.getItem(themeStorageKey),
    writePreference: (preference) => window.localStorage.setItem(themeStorageKey, preference),
    isSystemDark: () => media.matches,
    applyTheme: (theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', theme === 'dark' ? '#151e19' : '#f7f8f2');
    },
    subscribeToSystemChange: (listener) => media.addEventListener('change', listener),
    subscribeToStorageChange: (listener) => {
      window.addEventListener('storage', (event) => {
        if (event.key !== themeStorageKey && event.key !== null) return;
        try {
          if (event.storageArea !== null && event.storageArea !== window.localStorage) return;
        } catch {
          return;
        }
        listener(event.key === null ? null : event.newValue);
      });
    },
  };
}

export function createThemeStore() {
  let preference: ThemePreference = 'system';
  let environment: ThemeEnvironment | undefined;
  const listeners = new Set<() => void>();

  function applyTheme() {
    if (!environment) return;
    const theme =
      preference === 'system' ? (environment.isSystemDark() ? 'dark' : 'light') : preference;
    environment.applyTheme(theme);
  }

  function updatePreference(next: ThemePreference) {
    const changed = preference !== next;
    preference = next;
    applyTheme();
    if (changed) listeners.forEach((listener) => listener());
  }

  return {
    initialize(injectedEnvironment?: ThemeEnvironment) {
      if (environment) return;
      environment = injectedEnvironment ?? browserEnvironment();
      let stored: string | null = null;
      try {
        stored = environment.readPreference();
      } catch {
        // Storage can be disabled; the current page still follows the system.
      }
      updatePreference(parsePreference(stored));
      environment.subscribeToSystemChange(() => {
        if (preference === 'system') applyTheme();
      });
      environment.subscribeToStorageChange((value) => updatePreference(parsePreference(value)));
    },
    getSnapshot: () => preference,
    getServerSnapshot: (): ThemePreference => 'system',
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setPreference(next: ThemePreference) {
      try {
        environment?.writePreference(next);
      } catch {
        // Persistence is optional; an explicit choice always works in this page.
      }
      updatePreference(next);
    },
  };
}

const themeStore = createThemeStore();

export const initializeTheme = themeStore.initialize;
export const getThemeSnapshot = themeStore.getSnapshot;
export const getServerThemeSnapshot = themeStore.getServerSnapshot;
export const subscribeTheme = themeStore.subscribe;
export const setThemePreference = themeStore.setPreference;
