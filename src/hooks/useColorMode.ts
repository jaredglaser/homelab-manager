import { useCallback, useSyncExternalStore } from 'react';

export type ColorMode = 'light' | 'dark';

const STORAGE_KEY = 'color-scheme';
const DEFAULT_MODE: ColorMode = 'dark';

function applyMode(mode: ColorMode): void {
  document.documentElement.dataset.colorScheme = mode;
}

/**
 * Read the current mode. The pre-paint init script in __root.tsx sets the
 * data-color-scheme attribute before first paint, so trusting it here keeps the
 * hook's first render aligned with what the user already sees (no theme flash).
 */
function readMode(): ColorMode {
  const attr = document.documentElement.dataset.colorScheme;
  if (attr === 'light' || attr === 'dark') return attr;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // localStorage can throw in private-mode / sandboxed contexts; fall through.
  }
  return DEFAULT_MODE;
}

const listeners = new Set<() => void>();

export function setColorMode(mode: ColorMode): void {
  applyMode(mode);
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Persisting is best-effort; the in-memory attribute still drives the theme.
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    // Mirror another tab's choice into this tab's attribute before re-rendering.
    if (e.newValue === 'light' || e.newValue === 'dark') applyMode(e.newValue);
    cb();
  };
  globalThis.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    globalThis.removeEventListener('storage', onStorage);
  };
}

/**
 * Tracks light/dark mode, persists it to localStorage, drives the
 * `data-color-scheme` attribute that Tailwind's `dark:` variant keys off,
 * and stays in sync across tabs.
 */
export function useColorMode(): {
  mode: ColorMode;
  setMode: (mode: ColorMode) => void;
  toggle: () => void;
} {
  const mode = useSyncExternalStore(subscribe, readMode, () => DEFAULT_MODE);
  const setMode = useCallback((m: ColorMode) => setColorMode(m), []);
  const toggle = useCallback(() => setColorMode(readMode() === 'dark' ? 'light' : 'dark'), []);
  return { mode, setMode, toggle };
}
