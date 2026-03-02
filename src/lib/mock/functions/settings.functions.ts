import { DEMO_SETTINGS_STORAGE_KEY } from '@/lib/mock/generators/settings';

/**
 * Mock: Update a setting — persists to localStorage in demo mode.
 * Matches the real `updateSetting` signature.
 */
export const updateSetting = async (opts: {
  data: { key: string; value: string };
}): Promise<void> => {
  const { key, value } = opts.data;

  let settings: Record<string, string> = {};
  try {
    const stored = localStorage.getItem(DEMO_SETTINGS_STORAGE_KEY);
    if (stored) settings = JSON.parse(stored) as Record<string, string>;
  } catch { /* ignore */ }

  settings[key] = value;
  localStorage.setItem(DEMO_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
};
