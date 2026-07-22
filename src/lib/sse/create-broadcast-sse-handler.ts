import { createSseStream, isCloseRelatedError } from '@/lib/sse/create-sse-stream';

/**
 * Factory for subscribe-based SSE route handlers.
 *
 * Covers the shape shared by `/api/docker-inventory`, `/api/stack-status`,
 * and `/api/settings`: authenticate, subscribe to a broadcast service, and
 * forward each event via a caller-provided serializer. Wire mechanics
 * (headers, flush, heartbeat, abort teardown) live in `createSseStream`.
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
  /**
   * Named SSE event emitted when `loadSubscribe()` rejects, so clients can
   * surface the failure instead of silently stalling on an empty stream.
   */
  errorEvent: string;
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

    return createSseStream(request, {
      onStart: async (emit) => {
        let subscribe: (cb: (event: Event) => void) => Unsubscribe;
        try {
          subscribe = await options.loadSubscribe();
        } catch (err) {
          console.error(
            `Failed to initialize SSE subscription for event "${options.errorEvent}":`,
            err,
          );
          const message = err instanceof Error ? err.message : String(err);
          emit.event(options.errorEvent, { message });
          // Subscribe is unrecoverable for this request: end the stream
          // now rather than leaving it open with nothing left to send.
          emit.close();
          return;
        }

        return subscribe((event) => {
          // `serialize` is caller-supplied and runs outside createSseStream's
          // own enqueue try/catch (it produces the frame text, it doesn't
          // enqueue it), so a throw here needs the same treatment an enqueue
          // failure gets: swallow close races, log and tear down otherwise.
          try {
            emit.raw(options.serialize(event));
          } catch (err) {
            if (!isCloseRelatedError(err)) {
              console.error('Unexpected error during SSE enqueue:', err);
            }
            emit.close();
          }
        });
      },
    });
  };
}
