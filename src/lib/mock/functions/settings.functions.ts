import { DEMO_SETTINGS_STORAGE_KEY } from '@/lib/constants/settings-keys';
import { loadDemoSettings } from '@/lib/mock/generators/settings';
import { settingsUpdates, userSettingsUpdates } from '@/lib/mock/live-updates';

function storeDemoSetting(key: string, value: string): void {
  const settings = loadDemoSettings();
  settings[key] = value;
  localStorage.setItem(DEMO_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

/** Mock: persists a shared server setting to localStorage in demo mode. Matches the real `updateSetting` signature. */
export const updateSetting = (opts: {
  data: { key: string; value: string };
}): Promise<void> => {
  const { key, value } = opts.data;
  storeDemoSetting(key, value);
  settingsUpdates.emit({ type: 'change', key, value });
  return Promise.resolve();
};

/** Mock: the demo has one user, so its display preferences share the same localStorage record. */
export const updateUserSetting = (opts: {
  data: { key: string; value: string };
}): Promise<void> => {
  const { key, value } = opts.data;
  storeDemoSetting(key, value);
  userSettingsUpdates.emit({ type: 'change', key, value });
  return Promise.resolve();
};
