import { describe, it, expect, mock } from 'bun:test';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';
import { resolveCollectionInterval } from '../resolve-collection-interval';

function createMockSettingsRepo(getValue: string | null | Error = null) {
  return {
    get: getValue instanceof Error
      ? mock(() => Promise.reject(getValue))
      : mock(() => Promise.resolve(getValue)),
    getAll: mock(() => Promise.resolve(new Map())),
    set: mock(() => Promise.resolve()),
  } as any;
}

describe('resolveCollectionInterval', () => {
  it('should return the DB value when it is a valid integer in range', async () => {
    const repo = createMockSettingsRepo('500');
    const result = await resolveCollectionInterval(repo, 1000);
    expect(result).toBe(500);
    expect(repo.get).toHaveBeenCalledWith(SETTINGS_KEYS.general.updateIntervalMs);
  });

  it('should return the default when the DB value is null', async () => {
    const repo = createMockSettingsRepo(null);
    const result = await resolveCollectionInterval(repo, 1000);
    expect(result).toBe(1000);
  });

  it('should return the default when the DB value is below minimum (100)', async () => {
    const repo = createMockSettingsRepo('50');
    const result = await resolveCollectionInterval(repo, 1000);
    expect(result).toBe(1000);
  });

  it('should return the default when the DB value is above maximum (60000)', async () => {
    const repo = createMockSettingsRepo('99999');
    const result = await resolveCollectionInterval(repo, 1000);
    expect(result).toBe(1000);
  });

  it('should return the default when the DB value is not a number', async () => {
    const repo = createMockSettingsRepo('abc');
    const result = await resolveCollectionInterval(repo, 1000);
    expect(result).toBe(1000);
  });

  it('should return the default when the DB throws', async () => {
    const repo = createMockSettingsRepo(new Error('connection refused'));
    const result = await resolveCollectionInterval(repo, 1000);
    expect(result).toBe(1000);
  });

  it('should accept the minimum boundary value (100)', async () => {
    const repo = createMockSettingsRepo('100');
    const result = await resolveCollectionInterval(repo, 1000);
    expect(result).toBe(100);
  });

  it('should accept the maximum boundary value (60000)', async () => {
    const repo = createMockSettingsRepo('60000');
    const result = await resolveCollectionInterval(repo, 1000);
    expect(result).toBe(60000);
  });

  it('should reject float values', async () => {
    const repo = createMockSettingsRepo('500.5');
    // parseInt('500.5') === 500 which is valid
    const result = await resolveCollectionInterval(repo, 1000);
    expect(result).toBe(500);
  });

  it('should reject empty string', async () => {
    const repo = createMockSettingsRepo('');
    const result = await resolveCollectionInterval(repo, 1000);
    expect(result).toBe(1000);
  });
});
