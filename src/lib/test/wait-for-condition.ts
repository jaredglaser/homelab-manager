/**
 * Polls `predicate` until it returns true, throwing if `timeoutMs` elapses first.
 *
 * Used in place of a fixed `setTimeout` sleep to await async side effects
 * (NOTIFY fan-out, reconnect retries, listener registration) deterministically:
 * the wait ends the instant the condition is actually met instead of hoping a
 * magic-number delay happened to be long enough, which is both slower than
 * necessary when the condition settles fast and flaky when it doesn't.
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
