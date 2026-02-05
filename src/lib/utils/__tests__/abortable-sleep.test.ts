import { describe, it, expect } from 'bun:test';
import { abortableSleep, isAbortError } from '../abortable-sleep';

describe('abortableSleep', () => {
  it('should resolve after the specified duration', async () => {
    const start = Date.now();
    await abortableSleep(50, new AbortController().signal);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it('should reject immediately if signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableSleep(5000, controller.signal)).rejects.toThrow();
  });

  it('should reject when signal is aborted during sleep', async () => {
    const controller = new AbortController();
    const promise = abortableSleep(5000, controller.signal);
    setTimeout(() => controller.abort(), 10);

    const start = Date.now();
    await expect(promise).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('should reject with the abort reason when provided', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Custom reason', 'AbortError');
    const promise = abortableSleep(5000, controller.signal);
    controller.abort(reason);

    try {
      await promise;
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBe(reason);
    }
  });
});

describe('isAbortError', () => {
  it('should return true for DOMException AbortError', () => {
    expect(isAbortError(new DOMException('Aborted', 'AbortError'))).toBe(true);
  });

  it('should return true for Error with name AbortError', () => {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    expect(isAbortError(err)).toBe(true);
  });

  it('should return false for other errors', () => {
    expect(isAbortError(new Error('Something else'))).toBe(false);
  });

  it('should return false for non-error values', () => {
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError('string')).toBe(false);
  });
});
