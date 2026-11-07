export const compactStorageKey = 'lingoweave.compact';

export interface AppearanceEnvironment {
  readCompact(): string | null;
  writeCompact(compact: boolean): void;
  applyCompact(compact: boolean): void;
  subscribeToStorageChange(listener: (value: string | null) => void): void;
}

function browserEnvironment(): AppearanceEnvironment {
  return {
    readCompact: () => window.localStorage.getItem(compactStorageKey),
    writeCompact: (compact) => window.localStorage.setItem(compactStorageKey, String(compact)),
    applyCompact: (compact) => {
      document.documentElement.dataset.compact = String(compact);
    },
    subscribeToStorageChange: (listener) => {
      window.addEventListener('storage', (event) => {
        if (event.key !== compactStorageKey && event.key !== null) return;
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

export function createAppearanceStore() {
  let compact = false;
  let environment: AppearanceEnvironment | undefined;
  const listeners = new Set<() => void>();

  function updateCompact(next: boolean) {
    const changed = compact !== next;
    compact = next;
    environment?.applyCompact(compact);
    if (changed) listeners.forEach((listener) => listener());
  }

  return {
    initialize(injectedEnvironment?: AppearanceEnvironment) {
      if (environment) return;
      environment = injectedEnvironment ?? browserEnvironment();
      let stored: string | null = null;
      try {
        stored = environment.readCompact();
      } catch {
        // Unavailable storage keeps the full interface as the default.
      }
      updateCompact(stored === 'true');
      environment.subscribeToStorageChange((value) => updateCompact(value === 'true'));
    },
    getSnapshot: () => compact,
    getServerSnapshot: () => false,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setCompact(next: boolean) {
      try {
        environment?.writeCompact(next);
      } catch {
        // An explicit choice remains available in this page without persistence.
      }
      updateCompact(next);
    },
  };
}

const appearanceStore = createAppearanceStore();

export const initializeAppearance = appearanceStore.initialize;
export const getCompactSnapshot = appearanceStore.getSnapshot;
export const getServerCompactSnapshot = appearanceStore.getServerSnapshot;
export const subscribeAppearance = appearanceStore.subscribe;
export const setCompactMode = appearanceStore.setCompact;
