import { describe, it, expect } from 'bun:test';
import { generateDefaultSettings } from '../settings';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';

describe('generateDefaultSettings', () => {
  it('returns a non-empty object', () => {
    const settings = generateDefaultSettings();
    expect(Object.keys(settings).length).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const a = generateDefaultSettings();
    const b = generateDefaultSettings();
    expect(a).toEqual(b);
  });

  it('includes all canonical settings keys', () => {
    const settings = generateDefaultSettings();

    // Check a representative set of keys from each category
    expect(settings[SETTINGS_KEYS.general.use12HourTime]).toBeDefined();
    expect(settings[SETTINGS_KEYS.general.updateIntervalMs]).toBe('1000');
    expect(settings[SETTINGS_KEYS.docker.memoryDisplayMode]).toBe('percent');
    expect(settings[SETTINGS_KEYS.zfs.expandedPools]).toBe('[]');
    expect(settings[SETTINGS_KEYS.proxmox.updateInterval]).toBe('1000');
    expect(settings[SETTINGS_KEYS.retention.rawDataHours]).toBe('24');
    expect(settings[SETTINGS_KEYS.developer.dockerDebugLogging]).toBe('false');
  });

  it('all values are strings', () => {
    const settings = generateDefaultSettings();
    for (const [key, value] of Object.entries(settings)) {
      expect(typeof value).toBe('string');
      // Verify key is a non-empty string
      expect(key.length).toBeGreaterThan(0);
    }
  });
});
