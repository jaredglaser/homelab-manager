import { createSseStream, isCloseRelatedError } from '@/lib/sse/create-sse-stream';

/**
 * Factory for subscribe-based SSE route handlers (`/api/docker-inventory`,
 * `/api/stack-status`, `/api/settings`). Wire mechanics live in `createSseStream`.
 */
type Unsubscribe = () => void;

export interface BroadcastSseHandlerOptions<Event> {
  /** Called once per request; owns any dynamic imports and returns a subscribe fn bound to its broadcast service. */
  loadSubscribe: () => Promise<(cb: (event: Event) => void) => Unsubscribe>;
  /** Produces the complete SSE frame (including `data:`/`event:` prefixes and trailing `\n\n`). */
  serialize: (event: Event) => string;
  /** Named SSE event emitted when `loadSubscribe()` rejects. */
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
          emit.close();
          return;
        }

        return subscribe((event) => {
          // serialize() runs outside createSseStream's enqueue try/catch, so mirror its error handling here.
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
