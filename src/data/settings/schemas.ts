import { z } from 'zod';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';

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

const VALID_KEYS = collectValues(SETTINGS_KEYS) as [SettingsKey, ...SettingsKey[]];

export const updateSettingSchema = z.object({
  key: z.enum(VALID_KEYS),
  value: z.string(),
});
