/**
 * Cancellable sleep that rejects with AbortError when the signal is aborted.
 * Enables immediate wakeup during graceful shutdown instead of waiting
 * for the full timeout to elapse.
 */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Type guard for AbortError — used to distinguish intentional shutdown
 * from real errors in catch blocks.
 */
export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}
