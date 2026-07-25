/**
 * Single owner of the SSE wire protocol for the agent: headers, initial flush,
 * heartbeat, `data:`/`event:` frame grammar, and abort/enqueue-failure teardown.
 * Every SSE route builds its `Response` through this so those facts live in one
 * place instead of being re-derived per route.
 *
 * Deliberate duplicate of the web app's `src/lib/sse/create-sse-stream.ts`: the
 * agent ships as its own package with its own lockfile and cannot import web
 * code, so the seam exists once on each side of that split.
 */

// Quiet streams go silent past idle timeouts (Bun's HTTP idleTimeout defaults
// to 10s), causing consumer reconnect churn; a periodic comment keeps them warm.
const DEFAULT_HEARTBEAT_MS = 5000;

/** Frame-writing surface handed to `onStart`; no caller writes `\n\n` or `data: ` by hand. */
export interface SseEmitter {
  /** Writes a `data: <JSON>\n\n` frame. */
  data(payload: unknown): void;
  /** Writes an `event: <name>\ndata: <JSON>\n\n` frame. */
  event(name: string, payload: unknown): void;
  /** Writes a chunk verbatim (a pre-formatted frame string, or raw bytes piped from an upstream SSE source). */
  raw(chunk: string | Uint8Array): void;
  /** Ends the stream now (clears heartbeat, runs `onStart` cleanup, closes controller). */
  close(): void;
}

export type SseCleanup = () => void;

export type SseOnStart = (
  emit: SseEmitter,
  signal: AbortSignal,
) => void | SseCleanup | Promise<void | SseCleanup>;

export interface CreateSseStreamOptions {
  /** Called once per request after the flush and heartbeat are armed. May return a cleanup, run once at teardown. */
  onStart: SseOnStart;
  /** Heartbeat cadence in ms. Defaults to 5000. */
  heartbeatMs?: number;
}

/** True for the TypeError Web Streams throws on enqueue/close after the controller already closed. */
export function isCloseRelatedError(err: unknown): boolean {
  return err instanceof TypeError && /closed/i.test(err.message);
}

export function createSseStream(request: Request, opts: CreateSseStreamOptions): Response {
  const { onStart, heartbeatMs = DEFAULT_HEARTBEAT_MS } = opts;
  const encoder = new TextEncoder();
  let closed = false;
  let cleanup: SseCleanup | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

      const teardown = () => {
        if (closed) return;
        closed = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        cleanup?.();
        try {
          controller.close();
        } catch {}
      };

      // Deferred build lets a JSON.stringify failure (circular ref, BigInt) hit the same catch as an enqueue failure.
      const write = (build: () => string | Uint8Array) => {
        if (closed) return;
        try {
          const value = build();
          controller.enqueue(typeof value === 'string' ? encoder.encode(value) : value);
        } catch (err) {
          if (!isCloseRelatedError(err)) {
            console.error('Unexpected error during SSE enqueue:', err);
          }
          teardown();
        }
      };

      const emit: SseEmitter = {
        data: (payload) => write(() => `data: ${JSON.stringify(payload)}\n\n`),
        event: (name, payload) => write(() => `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`),
        raw: (chunk) => write(() => chunk),
        close: teardown,
      };

      // Flushes response headers immediately so clients don't stall on the first byte.
      write(() => ': ok\n\n');
      heartbeatTimer = setInterval(() => write(() => ':\n\n'), heartbeatMs);

      // Registered before onStart so an abort mid-setup tears down right away.
      request.signal.addEventListener('abort', teardown);

      let result: void | SseCleanup = undefined;
      try {
        result = await onStart(emit, request.signal);
      } catch (err) {
        console.error('Unexpected error in SSE onStart handler:', err);
        teardown();
      }

      if (closed) {
        // Teardown already ran mid-setup (abort, or onStart called emit.close()); run its cleanup now.
        result?.();
      } else {
        cleanup = result ?? undefined;
        // onStart can resolve after an abort mid-setup; recheck so a subscription doesn't leak past disconnect.
        if (request.signal.aborted) teardown();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
