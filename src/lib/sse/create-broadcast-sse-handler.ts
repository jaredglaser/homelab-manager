/**
 * Factory for subscribe-based SSE route handlers.
 *
 * Covers the shape shared by `/api/docker-inventory`, `/api/stack-status`,
 * and `/api/settings`: open a stream, emit a heartbeat comment, subscribe to
 * a broadcast service, forward each event via a caller-provided serializer,
 * and tear down on request abort or enqueue failure.
 *
 * The heartbeat (`: ok\n\n`) forces Nitro to flush response headers
 * immediately so clients don't stall waiting for the first byte.
 */
type Unsubscribe = () => void;

// These streams only emit when their broadcast source changes (a settings write,
// a container state change), so a quiet homelab leaves them silent well past the
// idle timeout of the runtime (Bun's HTTP default is 10s) and any reverse proxy.
// Without traffic the socket is dropped, the browser's EventSource reconnects,
// and the churn of short-lived streams trips Caddy's (Go net/http2) rapid-reset
// protection, which GOAWAYs the whole HTTP/2 connection: every multiplexed
// request dies at once. A comment heartbeat keeps the stream warm. 5s stays
// under typical Bun/proxy idle defaults; mirrors the agent's logs route.
const HEARTBEAT_INTERVAL_MS = 5_000;

export interface BroadcastSseHandlerOptions<Event> {
  /**
   * Called once per request. Responsible for any dynamic imports of
   * server-only modules and for returning a subscribe function already
   * bound to its broadcast service.
   */
  loadSubscribe: () => Promise<(cb: (event: Event) => void) => Unsubscribe>;
  /**
   * Produce the complete SSE frame, including any `data:` / `event:` prefixes
   * and the trailing `\n\n`. Letting callers own the full frame lets them
   * emit named SSE events when they need to.
   */
  serialize: (event: Event) => string;
  /**
   * Named SSE event emitted when `loadSubscribe()` rejects, so clients can
   * surface the failure instead of silently stalling on an empty stream.
   */
  errorEvent: string;
}

function isCloseRelatedError(err: unknown): boolean {
  return err instanceof TypeError && /closed/i.test(err.message);
}

export function createBroadcastSseHandler<Event>(
  options: BroadcastSseHandlerOptions<Event>,
) {
  return async ({ request }: { request: Request }): Promise<Response> => {
    const { authenticateSSE } = await import('@/lib/auth/sse-auth');
    const user = await authenticateSSE(request);
    if (!user) {
      return new Response('Unauthorized', { status: 401 });
    }

    const encoder = new TextEncoder();
    let closed = false;

    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(': ok\n\n'));

        let unsubscribe: Unsubscribe = () => {};
        let heartbeat: ReturnType<typeof setInterval> | null = null;

        const teardown = () => {
          if (closed) return;
          closed = true;
          if (heartbeat !== null) {
            clearInterval(heartbeat);
            heartbeat = null;
          }
          unsubscribe();
          try {
            controller.close();
          } catch {}
        };

        const sendEvent = (event: Event) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(options.serialize(event)));
          } catch (err) {
            if (!isCloseRelatedError(err)) {
              console.error('Unexpected error during SSE enqueue:', err);
            }
            teardown();
          }
        };

        let subscribe: (cb: (event: Event) => void) => Unsubscribe;
        try {
          subscribe = await options.loadSubscribe();
        } catch (err) {
          console.error(
            `Failed to initialize SSE subscription for event "${options.errorEvent}":`,
            err,
          );
          const message = err instanceof Error ? err.message : String(err);
          try {
            controller.enqueue(
              encoder.encode(
                `event: ${options.errorEvent}\ndata: ${JSON.stringify({ message })}\n\n`,
              ),
            );
          } catch {}
          closed = true;
          try {
            controller.close();
          } catch {}
          return;
        }

        unsubscribe = subscribe(sendEvent);

        heartbeat = setInterval(() => {
          if (closed) {
            clearInterval(heartbeat!);
            heartbeat = null;
            return;
          }
          try {
            controller.enqueue(encoder.encode(':\n\n'));
          } catch (err) {
            if (!isCloseRelatedError(err)) {
              console.error('Unexpected error during SSE heartbeat:', err);
            }
            teardown();
          }
        }, HEARTBEAT_INTERVAL_MS);

        request.signal.addEventListener('abort', teardown);
        // If the client disconnected during the awaits above, the abort event
        // already fired and the listener will never run; tear down now so the
        // subscription doesn't leak.
        if (request.signal.aborted) teardown();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  };
}
