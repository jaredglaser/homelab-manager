import { describe, it, expect } from 'bun:test';
import { updateSettingSchema, updateUserSettingSchema } from '../schemas';
import { SETTINGS_KEYS, USER_SETTINGS_KEYS } from '@/lib/constants/settings-keys';

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
    const result = updateSettingSchema.parse({ key: 'general/updateIntervalMs', value: '1000' });
    expect(result.key).toBe('general/updateIntervalMs');
    expect(result.value).toBe('1000');
  });

  it('accepts exactly the four shared server settings', () => {
    const allKeys = collectValues(SETTINGS_KEYS);
    const accepted = allKeys.filter((key) => updateSettingSchema.safeParse({ key, value: 'x' }).success);
    expect([...accepted].sort()).toEqual([
      'developer/dbFlushDebugLogging',
      'developer/dockerDebugLogging',
      'general/updateIntervalMs',
      'proxmox/updateInterval',
    ]);
  });

  it.each([...USER_SETTINGS_KEYS])('rejects the per-user display key %s', (key) => {
    expect(() => updateSettingSchema.parse({ key, value: 'true' })).toThrow();
  });

  it('rejects unknown keys', () => {
    expect(() => updateSettingSchema.parse({ key: 'theme', value: 'dark' })).toThrow();
  });

  it.each([
    'docker/expandedHosts',
    'docker/expandedContainers',
    'docker/containerShells',
    'stacks/expandedStacks',
    'zfs/expandedHosts',
    'zfs/expandedPools',
    'zfs/expandedVdevs',
    'proxmox/expandedHosts',
    'proxmox/expandedSections',
  ])('rejects the per-browser layout key %s', (key) => {
    expect(() => updateSettingSchema.parse({ key, value: '[]' })).toThrow();
  });

  it.each([
    'retention/rawDataHours',
    'retention/minuteAggDays',
    'retention/hourAggDays',
  ])('rejects the removed retention key %s', (key) => {
    expect(() => updateSettingSchema.parse({ key, value: '24' })).toThrow();
  });

  it('rejects empty key', () => {
    expect(() => updateSettingSchema.parse({ key: '', value: 'x' })).toThrow();
  });

  it('rejects keys not in the canonical list', () => {
    expect(() => updateSettingSchema.parse({ key: 'general/nonexistent', value: 'x' })).toThrow();
    expect(() => updateSettingSchema.parse({ key: 'fake/key', value: 'x' })).toThrow();
  });

  it('accepts empty value string', () => {
    expect(updateSettingSchema.parse({ key: 'general/updateIntervalMs', value: '' }).value).toBe('');
  });
});

describe('updateUserSettingSchema', () => {
  it('accepts every per-user display key and nothing else', () => {
    const allKeys = collectValues(SETTINGS_KEYS);
    const accepted = allKeys.filter((key) => updateUserSettingSchema.safeParse({ key, value: 'x' }).success);
    expect([...accepted].sort()).toEqual([...USER_SETTINGS_KEYS].sort());
    expect(accepted).toHaveLength(12);
  });

  it.each([
    ['userId', 2],
    ['user_id', 2],
    ['user', { id: 2 }],
  ])('rejects a body that names a user through %s', (field, value) => {
    expect(() => updateUserSettingSchema.parse({ key: 'general/use12HourTime', value: 'true', [field]: value })).toThrow();
  });

  it('bounds the stored value', () => {
    expect(() => updateUserSettingSchema.parse({ key: 'general/lightPalette', value: 'x'.repeat(256) })).toThrow();
  });
});
