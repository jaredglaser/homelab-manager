import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { backoffDelayMs, retry } from '../backoff';

describe('backoffDelayMs', () => {
  it('defaults: produces the expected sequence capped at 30_000', () => {
    expect(backoffDelayMs(0)).toBe(500);
    expect(backoffDelayMs(1)).toBe(1000);
    expect(backoffDelayMs(2)).toBe(2000);
    expect(backoffDelayMs(3)).toBe(4000);
    expect(backoffDelayMs(5)).toBe(16_000);
    // 500 * 2^6 = 32_000 > capMs 30_000, so cap wins.
    expect(backoffDelayMs(6)).toBe(30_000);
    // Large attempts stay pinned to the cap.
    expect(backoffDelayMs(100)).toBe(30_000);
  });

  it('respects a custom baseMs', () => {
    expect(backoffDelayMs(0, { baseMs: 1000 })).toBe(1000);
  });

  it('clamps the exponent when maxExponent is set', () => {
    // attempt 3 but maxExponent 2 → 2^2 = 4, 1000 * 4 = 4000.
    expect(backoffDelayMs(3, { baseMs: 1000, maxExponent: 2 })).toBe(4000);
  });

  it('lets capMs win when smaller than the exponent would produce', () => {
    // 500 * 2^10 = 512_000, clamped to 10_000.
    expect(backoffDelayMs(10, { baseMs: 500, capMs: 10_000 })).toBe(10_000);
  });

  it('clamps negative attempts to 0', () => {
    expect(backoffDelayMs(-1)).toBe(500);
  });
});

describe('retry', () => {
  let setTimeoutSpy: ReturnType<typeof spyOn>;
  let capturedDelays: number[];

  beforeEach(() => {
    capturedDelays = [];
    // Fire timers synchronously so delay math is exercised without real waiting.
    setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: TimerHandler, delay?: number) => {
        capturedDelays.push(delay ?? 0);
        if (typeof fn === 'function') fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
    );
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  it('succeeds on first attempt → fn called once, onRetry not invoked', async () => {
    let calls = 0;
    let retries = 0;
    const result = await retry(
      async () => { calls++; return 'ok'; },
      {
        maxAttempts: 3,
        isRetryable: () => true,
        onRetry: () => { retries++; },
      },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(1);
    expect(retries).toBe(0);
    // No sleeps are expected for a successful first attempt.
    expect(capturedDelays).toEqual([]);
  });

  it('succeeds on attempt 3 after 2 retryable failures', async () => {
    let calls = 0;
    const retryArgs: Array<{ attempt: number; delayMs: number }> = [];
    const result = await retry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('transient');
        return 42;
      },
      {
        maxAttempts: 5,
        isRetryable: () => true,
        onRetry: (_err, attempt, delayMs) => { retryArgs.push({ attempt, delayMs }); },
      },
    );

    expect(result).toBe(42);
    expect(calls).toBe(3);
    // Two retries: (attempt 1, delay 500) then (attempt 2, delay 1000).
    expect(retryArgs).toEqual([
      { attempt: 1, delayMs: 500 },
      { attempt: 2, delayMs: 1000 },
    ]);
    expect(capturedDelays).toEqual([500, 1000]);
  });

  it('all attempts throw retryable → rejects with the last error; fn called maxAttempts times', async () => {
    let calls = 0;
    const errors = [new Error('e1'), new Error('e2'), new Error('e3')];
    let thrown: unknown;
    try {
      await retry(
        async () => {
          const err = errors[calls];
          calls++;
          throw err;
        },
        {
          maxAttempts: 3,
          isRetryable: () => true,
        },
      );
      expect.unreachable('retry should have thrown');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(errors[2]);
    expect(calls).toBe(3);
    // Two sleeps between three attempts (none after the last failure).
    expect(capturedDelays).toEqual([500, 1000]);
  });

  it('non-retryable error on first attempt → rejects immediately, no sleep', async () => {
    let calls = 0;
    const err = new Error('fatal');
    await expect(
      retry(
        async () => {
          calls++;
          throw err;
        },
        {
          maxAttempts: 5,
          isRetryable: () => false,
        },
      ),
    ).rejects.toBe(err);
    expect(calls).toBe(1);
    expect(capturedDelays).toEqual([]);
  });

  it('maxAttempts: 1 + single throw → rejects immediately', async () => {
    let calls = 0;
    const err = new Error('only one shot');
    await expect(
      retry(
        async () => {
          calls++;
          throw err;
        },
        {
          maxAttempts: 1,
          isRetryable: () => true,
        },
      ),
    ).rejects.toBe(err);
    expect(calls).toBe(1);
    expect(capturedDelays).toEqual([]);
  });

  it('already-aborted signal: sleep rejects with AbortError on the first retry', async () => {
    // Restore the synchronous setTimeout spy for this test; abortableSleep
    // checks signal.aborted synchronously and rejects before scheduling.
    setTimeoutSpy.mockRestore();

    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    let thrown: unknown;
    try {
      await retry(
        async () => {
          calls++;
          throw new Error('boom');
        },
        {
          maxAttempts: 3,
          isRetryable: () => true,
          signal: controller.signal,
        },
      );
      expect.unreachable('retry should have rejected');
    } catch (err) {
      thrown = err;
    }
    // Exactly one call before the first sleep, which rejects immediately.
    expect(calls).toBe(1);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe('AbortError');
  });

  it('invalid maxAttempts: 0 → throws synchronously', async () => {
    await expect(
      retry(async () => 'nope', { maxAttempts: 0, isRetryable: () => true }),
    ).rejects.toThrow('retry: maxAttempts must be >= 1');
  });
});
