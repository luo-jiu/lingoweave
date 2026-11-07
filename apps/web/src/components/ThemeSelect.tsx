import { useSyncExternalStore } from 'react';
import {
  getServerThemeSnapshot,
  getThemeSnapshot,
  setThemePreference,
  subscribeTheme,
} from '../lib/theme';
import './ThemeSelect.css';

export function ThemeSelect() {
  const preference = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getServerThemeSnapshot);

  return (
    <label className="theme-select">
      <span className="theme-select-label">外观主题</span>
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {preference === 'system' ? (
          <>
            <rect x="3" y="4" width="18" height="13" rx="2" />
            <path d="M8 21h8m-4-4v4" />
          </>
        ) : preference === 'light' ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
          </>
        ) : (
          <path d="M20.5 13a8.5 8.5 0 0 1-9.5-9.5A8.5 8.5 0 1 0 20.5 13Z" />
        )}
      </svg>
      <select
        value={preference}
        onChange={(event) => {
          const value = event.target.value;
          if (value === 'system' || value === 'light' || value === 'dark') {
            setThemePreference(value);
          }
        }}
      >
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
    </label>
  );
}
