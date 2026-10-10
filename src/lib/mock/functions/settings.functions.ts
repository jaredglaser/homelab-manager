import { DEMO_SETTINGS_STORAGE_KEY } from '@/lib/constants/settings-keys';
import { loadDemoSettings } from '@/lib/mock/generators/settings';
import { settingsUpdates } from '@/lib/mock/live-updates';

/**
 * Mock: Update a setting - persists to localStorage in demo mode.
 * Matches the real `updateSetting` signature.
 */
export const updateSetting = async (opts: {
  data: { key: string; value: string };
}): Promise<void> => {
  const { key, value } = opts.data;
  const settings = loadDemoSettings();
  settings[key] = value;
  localStorage.setItem(DEMO_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  settingsUpdates.emit({ type: 'change', key, value });
};
