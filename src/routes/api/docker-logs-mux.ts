import { createFileRoute } from '@tanstack/react-router';
import { createSseStream } from '@/lib/sse/create-sse-stream';

/**
 * Multiplexed container logs: ONE SSE connection carries every expanded row's
 * log stream, tagged per `host/containerId` key. Which containers are
 * delivered is driven at runtime by POSTing subscribe/unsubscribe commands, so
 * expanding or collapsing rows never reopens the connection (the browser's
 * HTTP/1.1 six-connections-per-origin cap makes one connection per row
 * unworkable from the third expanded row on).
 *
 * - `GET ?session=<id>` attaches the SSE response to a session.
 * - `POST {session, subscribe[], unsubscribe[]}` mutates the live key set.
 *   Subscribing an already-active key resyncs it (upstream reopens, agent
 *   replays the backlog), which makes the client's reconnect-on-open full
 *   re-POST a self-healing resync.
 *
 * Frame protocol: `src/lib/docker/log-mux-service.ts`.
 */
export const Route = createFileRoute('/api/docker-logs-mux')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { authenticateSSE } = await import('@/lib/auth/sse-auth');
        const user = await authenticateSSE(request);
        if (!user) {
          return new Response('Unauthorized', { status: 401 });
        }

        const url = new URL(request.url);
        const { isValidSessionId } = await import('@/lib/docker/log-mux-service');
        const sessionId = url.searchParams.get('session');
        if (!isValidSessionId(sessionId)) {
          return new Response('Missing or invalid session query parameter', { status: 400 });
        }

        return createSseStream(request, {
          onStart: async (emit) => {
            const { attachSession } = await import('@/lib/docker/log-mux-service');
            return attachSession(sessionId, emit);
          },
        });
      },

      POST: async ({ request }) => {
        const { authenticateSSE } = await import('@/lib/auth/sse-auth');
        const user = await authenticateSSE(request);
        if (!user) {
          return new Response('Unauthorized', { status: 401 });
        }

        const body = await request.json().catch(() => null) as
          | { session?: unknown; subscribe?: unknown; unsubscribe?: unknown }
          | null;
        const isStringArray = (value: unknown): value is string[] =>
          Array.isArray(value) && value.every((v) => typeof v === 'string');
        if (
          !body
          || typeof body.session !== 'string'
          || (body.subscribe !== undefined && !isStringArray(body.subscribe))
          || (body.unsubscribe !== undefined && !isStringArray(body.unsubscribe))
          || (body.subscribe?.length ?? 0) > 30
          || (body.unsubscribe?.length ?? 0) > 50
        ) {
          return new Response('Invalid mux command body', { status: 400 });
        }

        const { mutateSession } = await import('@/lib/docker/log-mux-service');
        const result = await mutateSession(
          body.session,
          body.subscribe ?? [],
          body.unsubscribe ?? [],
        );
        if (!result.ok) {
          const status = result.reason === 'unknown-session' ? 409 : 400;
          return new Response(result.reason ?? 'Mux command failed', { status });
        }
        return new Response(null, { status: 204 });
      },
    },
  },
});
