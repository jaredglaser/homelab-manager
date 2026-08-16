import { describe, expect, test } from 'bun:test';
import { systemClock } from '@/worker/log-watcher/types';

describe('systemClock', () => {
  test('reads the real wall clock, so the unnamed default is not a frozen stub', () => {
    const before = Date.now();
    const observed = systemClock.now();
    const after = Date.now();

    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(after);
  });

  test('advances between reads rather than caching its first value', async () => {
    const first = systemClock.now();
    await new Promise<void>((resolve) => {
      const original = globalThis.setTimeout;
      original(() => resolve(), 2);
    });
    expect(systemClock.now()).toBeGreaterThanOrEqual(first);
  });
});
