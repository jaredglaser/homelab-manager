import { describe, it, expect } from 'bun:test';
import { updateSettingSchema } from '../schemas';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';

function collectValues(obj: Record<string, unknown>): string[] {
  const result: string[] = [];
  for (const value of Object.values(obj)) {
    if (typeof value === 'string') result.push(value);
    else if (typeof value === 'object' && value !== null) result.push(...collectValues(value as Record<string, unknown>));
  }
  return result;
}

describe('updateSettingSchema', () => {
  it('accepts a valid settings key and value', () => {
    const result = updateSettingSchema.parse({ key: 'general/use12HourTime', value: 'true' });
    expect(result.key).toBe('general/use12HourTime');
    expect(result.value).toBe('true');
  });

  it('accepts all known settings keys', () => {
    const allKeys = collectValues(SETTINGS_KEYS as unknown as Record<string, unknown>);
    expect(allKeys.length).toBeGreaterThan(0);
    for (const key of allKeys) {
      expect(() => updateSettingSchema.parse({ key, value: 'x' })).not.toThrow();
    }
  });

  it('rejects unknown keys', () => {
    expect(() => updateSettingSchema.parse({ key: 'theme', value: 'dark' })).toThrow();
  });

  it('rejects empty key', () => {
    expect(() => updateSettingSchema.parse({ key: '', value: 'x' })).toThrow();
  });

  it('rejects keys not in the canonical list', () => {
    expect(() => updateSettingSchema.parse({ key: 'general/nonexistent', value: 'x' })).toThrow();
    expect(() => updateSettingSchema.parse({ key: 'fake/key', value: 'x' })).toThrow();
  });

  it('accepts empty value string', () => {
    expect(updateSettingSchema.parse({ key: 'general/use12HourTime', value: '' }).value).toBe('');
  });
});
