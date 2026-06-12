/**
 * Default heartbeat period. Must stay below typical idle timeouts that kill
 * quiet streams (Bun's idleTimeout, nginx's 60 s proxy_read_timeout).
 */
export const SSE_HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Start a periodic SSE comment ping (`: ping\n\n`) that keeps proxies and
 * Bun's idleTimeout from killing streams with no traffic.
 *
 * The interval clears itself when `isClosed()` reports true or when enqueue
 * throws (controller already closed). Callers should still invoke the
 * returned stop function from their teardown path so the timer dies with the
 * stream instead of one period later.
 *
 * @param controller - Stream controller the ping frames are enqueued on
 * @param encoder - Shared TextEncoder for the session
 * @param isClosed - Reports whether the session has been torn down
 * @param intervalMs - Ping period in milliseconds (default: 25s)
 * @returns Stop function that clears the interval
 */
export function startSseHeartbeat(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  isClosed: () => boolean,
  intervalMs: number = SSE_HEARTBEAT_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    if (isClosed()) {
      clearInterval(timer);
      return;
    }
    try {
      controller.enqueue(encoder.encode(': ping\n\n'));
    } catch {
      clearInterval(timer);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

/** Enqueue an SSE data event, silently swallowing enqueue-after-close TypeError. */
export function sendSSE(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  closed: { value: boolean },
  data: string,
): void {
  if (closed.value) return;
  try {
    controller.enqueue(encoder.encode(`data: ${data}\n\n`));
  } catch (err) {
    if (err instanceof TypeError && /closed/i.test(err.message)) {
      // Controller was closed between our check and enqueue. Mark closed so
      // subsequent sends short-circuit without another enqueue attempt.
      closed.value = true;
      return;
    }
    if (err instanceof TypeError) throw err;
    console.error('Unexpected error during SSE enqueue:', err);
  }
}
