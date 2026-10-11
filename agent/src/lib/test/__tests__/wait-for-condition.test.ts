import { describe, expect, test } from 'bun:test';
import { waitForCondition } from '../wait-for-condition';

describe('waitForCondition', () => {
  test('returns immediately when the predicate is already true', async () => {
    let calls = 0;
    await waitForCondition(() => {
      calls += 1;
      return calls > 0;
    });
    expect(calls).toBe(1);
  });

  test('throws its message when the timeout elapses', async () => {
    await expect(
      waitForCondition(() => false, { timeoutMs: 25, intervalMs: 5, message: 'no luck' }),
    ).rejects.toThrow('no luck');
  });
});
