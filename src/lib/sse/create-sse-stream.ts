/**
 * Single owner of the SSE wire protocol: response headers, the initial
 * flush comment, heartbeat cadence, `data:`/`event:` frame grammar, and
 * abort/enqueue-failure teardown. Every SSE route (stats polling,
 * broadcast subscriptions, the docker-logs proxy) builds its `Response`
 * through this primitive so those wire facts exist in exactly one place
 * instead of being re-derived per adapter.
 *
 * This module only touches Web Streams / Fetch APIs, so it is safe to
 * import statically from route files; server-only work (auth, DB, agent
 * fetches) stays in the caller's `onStart`.
 */

// A quiet stream (no rows, no broadcast event) stays silent past the idle
// timeout of the runtime (Bun's HTTP default is 10s) and any reverse proxy.
// Without traffic the socket drops, the browser's EventSource reconnects,
// and the resulting churn of short-lived streams can trip a proxy's
// rapid-reset protection (e.g. Caddy/Go net/http2, post CVE-2023-44487),
// which GOAWAYs the whole HTTP/2 connection: every multiplexed request on
// it dies at once. A `:\n\n` comment every 5s keeps every stream this
// primitive builds under typical idle defaults, regardless of whether the
// underlying source (poll, broadcast, agent proxy) ever emits real data.
const DEFAULT_HEARTBEAT_MS = 5000;

/** Frame-writing surface handed to `onStart`; no caller writes `\n\n` or `data: ` by hand. */
export interface SseEmitter {
  /** Writes a `data: <JSON>\n\n` frame. */
  data(payload: unknown): void;
  /** Writes an `event: <name>\ndata: <JSON>\n\n` frame. */
  event(name: string, payload: unknown): void;
  /**
   * Writes a chunk verbatim, bypassing JSON encoding. Covers two cases
   * that don't fit `data`/`event`: a caller-owned pre-formatted frame
   * string (a serializer that already returns the full `data: ...\n\n`
   * text), and raw bytes piped through from an upstream SSE source (the
   * docker-logs proxy forwards the agent's already-framed stream as-is).
   */
  raw(chunk: string | Uint8Array): void;
  /**
   * Ends the stream immediately (clears the heartbeat, runs any
   * `onStart` cleanup, closes the controller). Use when a stream can't
   * recover from a setup failure and should not sit open heartbeating
   * with nothing left to deliver, e.g. broadcast subscribe failing.
   */
  close(): void;
}

export type SseCleanup = () => void;

export type SseOnStart = (
  emit: SseEmitter,
  signal: AbortSignal,
) => void | SseCleanup | Promise<void | SseCleanup>;

export interface CreateSseStreamOptions {
  /**
   * Called once per request after the initial flush and heartbeat are
   * armed. May return (or resolve to) a cleanup function; it runs
   * exactly once, whenever the stream tears down, regardless of whether
   * that happens before or after `onStart` itself resolves.
   */
  onStart: SseOnStart;
  /** Heartbeat cadence in ms. Defaults to 5000, matching the broadcast idle-timeout fix (#323). */
  heartbeatMs?: number;
}

/**
 * True for the TypeError Web Streams throws when enqueue/close race a
 * teardown that already closed the controller. Exported so adapters that
 * do their own work inside a subscribe callback (running a caller-supplied
 * serializer, say) can apply the same "don't log, just tear down" rule to
 * errors that never reach the primitive's own enqueue path.
 */
export function isCloseRelatedError(err: unknown): boolean {
  return err instanceof TypeError && /closed/i.test(err.message);
}

export function createSseStream(request: Request, opts: CreateSseStreamOptions): Response {
  const { onStart, heartbeatMs = DEFAULT_HEARTBEAT_MS } = opts;
  const encoder = new TextEncoder();
  let closed = false;
  let cleanup: SseCleanup | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

      const teardown = () => {
        if (closed) return;
        closed = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        cleanup?.();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      // `build` is deferred (not a plain string) so that a payload which
      // fails to JSON.stringify (circular reference, BigInt) is caught by
      // the same try/catch as an enqueue failure, instead of throwing
      // synchronously out of `emit.data`/`emit.event` before this runs.
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

      // Forces the runtime to flush response headers immediately so
      // clients don't stall waiting for the first byte.
      write(() => ': ok\n\n');
      heartbeatTimer = setInterval(() => write(() => ':\n\n'), heartbeatMs);

      // Registered before `onStart` runs so an abort during its (possibly
      // slow, dynamic-import-laden) setup tears the stream down right
      // away instead of waiting on setup to finish first.
      request.signal.addEventListener('abort', teardown);

      let result: void | SseCleanup = undefined;
      try {
        result = await onStart(emit, request.signal);
      } catch (err) {
        console.error('Unexpected error in SSE onStart handler:', err);
        // Setup itself failed: nothing will ever call emit again, so leaving
        // the stream open would just heartbeat forever with no payload
        // ever following. End it now instead.
        teardown();
      }

      if (closed) {
        // Teardown already ran while onStart was still setting up (abort,
        // or onStart called emit.close() itself); run its cleanup now
        // since the teardown that already fired couldn't have known
        // about it yet.
        result?.();
      } else {
        cleanup = result ?? undefined;
        // onStart can resolve after the request aborted mid-setup;
        // recheck so that race doesn't leak a subscription past
        // client disconnect.
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
