import { describe, expect, it } from 'bun:test';
import { parseIntervalMs, loadImageUpdateRefresherConfig, staleThresholdMs, DEFAULT_REFRESH_INTERVAL_MS } from '../refresher-config';

describe('parseIntervalMs', () => {
  it('defaults to 12 hours when the variable is unset', () => {
    expect(parseIntervalMs(undefined)).toBe(DEFAULT_REFRESH_INTERVAL_MS);
    expect(DEFAULT_REFRESH_INTERVAL_MS).toBe(12 * 60 * 60_000);
  });

  it('accepts a positive integer milliseconds value', () => {
    expect(parseIntervalMs('3600000')).toBe(3_600_000);
  });

  it('rejects zero, negatives, non-integers, and non-numeric values', () => {
    for (const bad of ['0', '-1', '1.5', 'twelve', '']) {
      expect(() => parseIntervalMs(bad)).toThrow('IMAGE_UPDATE_REFRESH_INTERVAL_MS');
    }
  });
});

describe('loadImageUpdateRefresherConfig', () => {
  it('reads the env value and derives the staleness threshold', () => {
    const config = loadImageUpdateRefresherConfig({ IMAGE_UPDATE_REFRESH_INTERVAL_MS: '60000' });
    expect(config.intervalMs).toBe(60_000);
    expect(staleThresholdMs(config)).toBe(120_000);
  });

  it('falls back to the default without the variable', () => {
    expect(loadImageUpdateRefresherConfig({}).intervalMs).toBe(DEFAULT_REFRESH_INTERVAL_MS);
  });
});
