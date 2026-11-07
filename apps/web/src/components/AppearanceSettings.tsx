import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import {
  getCompactSnapshot,
  getServerCompactSnapshot,
  setCompactMode,
  subscribeAppearance,
} from '../lib/appearance';
import { ThemeSelect } from './ThemeSelect';
import './AppearanceSettings.css';

export function AppearanceSettings() {
  const compact = useSyncExternalStore(
    subscribeAppearance,
    getCompactSnapshot,
    getServerCompactSnapshot,
  );
  const panelId = useId();
  const descriptionId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const checkboxRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);

  const positionPanel = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const bounds = trigger.getBoundingClientRect();
    const right = Math.max(
      16,
      Math.min(window.innerWidth - bounds.right, window.innerWidth - panel.offsetWidth - 16),
    );
    const top = Math.max(
      16,
      Math.min(bounds.bottom + 8, window.innerHeight - panel.offsetHeight - 16),
    );
    panel.style.right = `${right}px`;
    panel.style.top = `${top}px`;
  }, []);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', positionPanel);
    window.addEventListener('scroll', positionPanel, true);
    return () => {
      window.removeEventListener('resize', positionPanel);
      window.removeEventListener('scroll', positionPanel, true);
    };
  }, [open, positionPanel]);

  return (
    <div className="appearance-settings">
      <ThemeSelect />
      <button
        ref={triggerRef}
        type="button"
        className="appearance-settings-trigger"
        aria-label="显示设置"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        popoverTarget={panelId}
        title="显示设置"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m9 3-.7 2.3-2 .9L4.2 5.8 2 9.5l1.5 1.8v2L2 15.1l2.2 3.7 2.1-.4 2 .9L9 21h6l.7-1.7 2-.9 2.1.4 2.2-3.7-1.5-1.8v-2L22 9.5l-2.2-3.7-2.1.4-2-.9L15 3Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
      <div
        ref={panelRef}
        id={panelId}
        className="appearance-settings-panel"
        popover="auto"
        role="dialog"
        aria-label="显示设置"
        onToggle={(event) => {
          const isOpen = event.newState === 'open';
          setOpen(isOpen);
          if (isOpen) {
            positionPanel();
            checkboxRef.current?.focus({ preventScroll: true });
          }
        }}
      >
        <label className="appearance-compact-option">
          <input
            ref={checkboxRef}
            type="checkbox"
            checked={compact}
            aria-describedby={descriptionId}
            onChange={(event) => setCompactMode(event.target.checked)}
          />
          <span>简约模式</span>
        </label>
        <p id={descriptionId}>隐藏辅助说明，保留学习内容和必要提示。</p>
      </div>
    </div>
  );
}
