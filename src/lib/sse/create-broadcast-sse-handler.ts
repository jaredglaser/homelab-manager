/**
 * Factory for subscribe-based SSE route handlers.
 *
 * Covers the shape shared by `/api/docker-inventory`, `/api/stack-status`,
 * and `/api/settings`: open a stream, emit a heartbeat comment, subscribe to
 * a broadcast service, forward each event via a caller-provided serializer,
 * and tear down on request abort or enqueue failure.
 *
 * The initial comment (`: ok\n\n`) forces Nitro to flush response headers
 * immediately so clients don't stall waiting for the first byte. Periodic
 * `: ping\n\n` comments then keep idle connections alive.
 */
type Unsubscribe = () => void;

/**
 * Default heartbeat period. Must stay below typical idle timeouts that kill
 * quiet streams (Bun's idleTimeout, nginx's 60 s proxy_read_timeout).
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;

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
  /** Heartbeat comment period in milliseconds (default: 25s). */
  heartbeatIntervalMs?: number;
}

function isCloseRelatedError(err: unknown): boolean {
  return err instanceof TypeError && /closed/i.test(err.message);
}

export function createBroadcastSseHandler<Event>(
  options: BroadcastSseHandlerOptions<Event>,
) {
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

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

        const teardown = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          try {
            controller.close();
          } catch {}
        };

        // Broadcast events can be minutes apart (settings changes, deploys);
        // a periodic comment frame keeps proxies and Bun's idleTimeout from
        // killing the connection in between.
        const heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(': ping\n\n'));
          } catch {
            teardown();
          }
        }, heartbeatIntervalMs);

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
          teardown();
          return;
        }

        unsubscribe = subscribe(sendEvent);

        request.signal.addEventListener('abort', teardown);
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
