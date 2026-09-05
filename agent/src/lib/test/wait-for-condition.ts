/**
 * Bun:test counterpart of the web app's `src/lib/test/wait-for-condition.ts`.
 * The agent is not a workspace member and cannot import web code, so the
 * helper exists once on each side of the split (same seam as sse-stream.ts).
 */
export async function waitForCondition(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const { timeoutMs = 1000, intervalMs = 5, message = 'waitForCondition: condition not met within timeout' } = opts;
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
