import { describe, expect, test } from 'bun:test';
import { RETRY_DELAYS_MS, fetchWithRetry } from '../fetch-retry';

describe('fetchWithRetry', () => {
  const url = 'https://api.github.com/repos/o/r/issues/1/comments';
  const okRes = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  const errRes = (status: number, retryAfter?: string) =>
    new Response(null, { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} });

  function makeSleep() {
    const delays: number[] = [];
    return {
      sleep: async (ms: number): Promise<void> => {
        delays.push(ms);
      },
      delays,
    };
  }

  test('retry ladder is 2/4/8/16s', () => {
    expect(RETRY_DELAYS_MS).toEqual([2000, 4000, 8000, 16000]);
  });

  test('uses the default setTimeout sleep when none is injected', async () => {
    let calls = 0;
    const res = await fetchWithRetry(
      () => (++calls < 2 ? Promise.resolve(errRes(500)) : Promise.resolve(okRes())),
      url,
      {},
    );
    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
  }, 10_000);

  test('returns an ok response without sleeping', async () => {
    const { sleep, delays } = makeSleep();
    let calls = 0;
    const res = await fetchWithRetry(
      () => {
        calls++;
        return Promise.resolve(okRes());
      },
      url,
      {},
      sleep,
    );
    expect(res.ok).toBe(true);
    expect(calls).toBe(1);
    expect(delays).toHaveLength(0);
  });

  test('retries a transient 500 and returns the eventual ok', async () => {
    const { sleep, delays } = makeSleep();
    let calls = 0;
    const res = await fetchWithRetry(
      () => (++calls < 2 ? Promise.resolve(errRes(500)) : Promise.resolve(okRes())),
      url,
      {},
      sleep,
    );
    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
    expect(delays).toEqual([2000]);
  });

  test('fails a deterministic 404 on the first attempt without sleeping', async () => {
    const { sleep, delays } = makeSleep();
    let calls = 0;
    const res = await fetchWithRetry(
      () => {
        calls++;
        return Promise.resolve(errRes(404));
      },
      url,
      {},
      sleep,
    );
    expect(res.status).toBe(404);
    expect(calls).toBe(1);
    expect(delays).toHaveLength(0);
  });

  test('retries a 429 honoring a retry-after capped at 60s', async () => {
    const { sleep, delays } = makeSleep();
    let calls = 0;
    await fetchWithRetry(
      () => {
        calls++;
        return Promise.resolve(calls === 1 ? errRes(429, '120') : okRes());
      },
      url,
      {},
      sleep,
    );
    expect(calls).toBe(2);
    expect(delays).toEqual([60000]);
  });

  test('exhausts retries and returns the last failing response', async () => {
    const { sleep, delays } = makeSleep();
    let calls = 0;
    const res = await fetchWithRetry(
      () => {
        calls++;
        return Promise.resolve(errRes(503));
      },
      url,
      {},
      sleep,
    );
    expect(res.status).toBe(503);
    expect(calls).toBe(5);
    expect(delays).toEqual([2000, 4000, 8000, 16000]);
  });

  test('retries network errors and throws after exhaustion', async () => {
    const { sleep } = makeSleep();
    let calls = 0;
    const fail = (): Promise<Response> => {
      calls++;
      return Promise.reject(new TypeError('network down'));
    };
    await expect(fetchWithRetry(fail, url, {}, sleep)).rejects.toThrow('network down');
    expect(calls).toBe(5);
  });

  test('recovers from a network error mid-sequence', async () => {
    const { sleep, delays } = makeSleep();
    let calls = 0;
    const res = await fetchWithRetry(
      () => {
        calls++;
        return calls === 1 ? Promise.reject(new TypeError('network down')) : Promise.resolve(okRes());
      },
      url,
      {},
      sleep,
    );
    expect(res.ok).toBe(true);
    expect(delays).toEqual([2000]);
  });
});
