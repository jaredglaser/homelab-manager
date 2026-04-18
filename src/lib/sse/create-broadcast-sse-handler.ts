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
}

export function createBroadcastSseHandler<Event>(
  options: BroadcastSseHandlerOptions<Event>,
) {
  return async ({ request }: { request: Request }): Promise<Response> => {
    const subscribe = await options.loadSubscribe();
    const encoder = new TextEncoder();
    let closed = false;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(': ok\n\n'));

        const sendEvent = (event: Event) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(options.serialize(event)));
          } catch {
            teardown();
          }
        };

        const unsubscribe = subscribe(sendEvent);

        const teardown = () => {
          if (closed) return;
          closed = true;
          unsubscribe();
          try {
            controller.close();
          } catch {
            // Already closed
          }
        };

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
