import { z } from 'zod';
import { SETTINGS_KEYS, USER_SETTINGS_KEYS, isUserSettingsKey, type UserSettingsKey } from '@/lib/constants/settings-keys';

/** Recursively extract all string values from a nested object. */
type DeepStringValues<T> = T extends string
  ? T
  : T extends Record<string, unknown>
    ? DeepStringValues<T[keyof T]>
    : never;

/** Collect all leaf string values from a nested object at runtime. */
function collectValues(obj: Record<string, unknown>): string[] {
  const result: string[] = [];
  for (const value of Object.values(obj)) {
    if (typeof value === 'string') {
      result.push(value);
    } else if (typeof value === 'object' && value !== null) {
      result.push(...collectValues(value as Record<string, unknown>));
    }
  }
  return result;
}

export type SettingsKey = DeepStringValues<typeof SETTINGS_KEYS>;

export type GlobalSettingsKey = Exclude<SettingsKey, UserSettingsKey>;

const GLOBAL_KEYS = (collectValues(SETTINGS_KEYS) as SettingsKey[]).filter(
  (key): key is GlobalSettingsKey => !isUserSettingsKey(key),
) as [GlobalSettingsKey, ...GlobalSettingsKey[]];

export const updateSettingSchema = z.object({
  key: z.enum(GLOBAL_KEYS),
  value: z.string(),
});

// Strict, so a request body naming a user is rejected instead of silently ignored.
export const updateUserSettingSchema = z.strictObject({
  key: z.enum(USER_SETTINGS_KEYS),
  value: z.string().max(255),
});
