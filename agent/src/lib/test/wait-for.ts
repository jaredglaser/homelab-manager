/** Poll a real condition until it holds or the timeout elapses (bun:test stand-in for Testing Library waitFor). */
export async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
