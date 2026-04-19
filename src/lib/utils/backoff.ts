import { abortableSleep } from '@/lib/utils/abortable-sleep';

export interface BackoffOpts {
  /** Base delay in milliseconds (default: 500). */
  baseMs?: number;
  /** Hard ceiling on the returned delay in milliseconds (default: 30_000). */
  capMs?: number;
  /** Maximum exponent applied to 2^attempt before the cap (default: Infinity — cap alone bounds the result). */
  maxExponent?: number;
}

/**
 * Pure exponential-backoff delay calculator.
 *
 * Returns `min(baseMs * 2^min(attempt, maxExponent), capMs)`. Negative attempts
 * are clamped to 0. Intended for the single place we want to reason about
 * backoff sequences across broadcast services, collectors, and agent retries.
 */
export function backoffDelayMs(attempt: number, opts?: BackoffOpts): number {
  const baseMs = opts?.baseMs ?? 500;
  const capMs = opts?.capMs ?? 30_000;
  const maxExponent = opts?.maxExponent ?? Infinity;
  const exp = Math.min(Math.max(attempt, 0), maxExponent);
  return Math.min(baseMs * Math.pow(2, exp), capMs);
}

export interface RetryOpts extends BackoffOpts {
  /** Maximum number of attempts (must be >= 1). */
  maxAttempts: number;
  /** Return true if the error should trigger another attempt. */
  isRetryable: (err: unknown) => boolean;
  /** Optional abort signal — aborting rejects the current sleep with AbortError. */
  signal?: AbortSignal;
  /** Called before each sleep with the attempt number just completed (1-indexed) and the delay about to elapse. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Run `fn` with exponential backoff between attempts.
 *
 * - Stops immediately on a non-retryable error.
 * - Stops after `maxAttempts` retryable errors, rethrowing the last.
 * - Respects `opts.signal`: an abort during the sleep rejects with AbortError.
 */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {
  if (opts.maxAttempts < 1) throw new Error('retry: maxAttempts must be >= 1');
  const signal = opts.signal ?? new AbortController().signal;
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLastAttempt = attempt === opts.maxAttempts - 1;
      if (isLastAttempt || !opts.isRetryable(err)) throw err;
      const delayMs = backoffDelayMs(attempt, opts);
      opts.onRetry?.(err, attempt + 1, delayMs);
      await abortableSleep(delayMs, signal);
    }
  }
  // Unreachable: the loop always returns or throws on the last attempt.
  throw new Error('retry: no attempts made');
}
