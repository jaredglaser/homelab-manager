import { describe, it, expect } from 'bun:test';
import { updateSettingSchema } from '../schemas';

describe('updateSettingSchema', () => {
  it('accepts a valid settings key and value', () => {
    const result = updateSettingSchema.parse({ key: 'general/use12HourTime', value: 'true' });
    expect(result.key).toBe('general/use12HourTime');
    expect(result.value).toBe('true');
  });

  it('accepts all known settings keys', () => {
    const knownKeys = [
      'general/use12HourTime',
      'general/updateIntervalMs',
      'docker/memoryDisplayMode',
      'docker/decimals/cpu',
      'zfs/expandedHosts',
      'proxmox/updateInterval',
      'retention/rawDataHours',
      'developer/dockerDebugLogging',
      'stacks/expandedStacks',
    ];
    for (const key of knownKeys) {
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
