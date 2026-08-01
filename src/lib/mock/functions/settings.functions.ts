import { DEMO_SETTINGS_STORAGE_KEY, VIEW_STATE_KEYS } from '@/lib/constants/settings-keys';
import { generateDefaultSettings } from '@/lib/mock/generators/settings';

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

/**
 * Hand-edited storage can hold non-object JSON or non-string values; fall back
 * to defaults rather than feeding a malformed shape into the settings atoms.
 */
export function loadDemoSettings(): Record<string, string> {
  try {
    const stored = localStorage.getItem(DEMO_SETTINGS_STORAGE_KEY);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (isStringRecord(parsed)) return parsed;
    }
  } catch {
    /* ignore malformed storage */
  }
  return generateDefaultSettings();
}

function persist(key: string, value: string): void {
  const settings = loadDemoSettings();
  settings[key] = value;
  localStorage.setItem(DEMO_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

/**
 * Mock: Update a setting - persists to localStorage in demo mode.
 * Matches the real `updateSetting` signature.
 */
export const updateSetting = async (opts: {
  data: { key: string; value: string };
}): Promise<void> => {
  persist(opts.data.key, opts.data.value);
};

export const setViewState = async (opts: {
  data: { key: string; value: string };
}): Promise<void> => {
  persist(opts.data.key, opts.data.value);
};

export const getViewState = async (): Promise<Record<string, string>> => {
  const stored = loadDemoSettings();
  const result: Record<string, string> = {};
  for (const key of VIEW_STATE_KEYS) {
    const value = stored[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
};
