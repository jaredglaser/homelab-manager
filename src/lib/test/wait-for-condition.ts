/**
 * Polls `predicate` until it returns true, throwing if `timeoutMs` elapses first.
 *
 * For plain async services (NOTIFY fan-out, reconnect retries, listener
 * registration) where no promise or callback exposes the awaited state.
 */
export async function waitForCondition(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const { timeoutMs = 2000, intervalMs = 5, message = 'waitForCondition: condition not met within timeout' } = opts;
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
