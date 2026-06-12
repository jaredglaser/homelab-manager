import type { StatsSource } from '@/lib/database/subscription-service';

/**
 * Default heartbeat period. Must stay below typical idle timeouts that kill
 * quiet streams (Bun's idleTimeout, nginx's 60 s proxy_read_timeout).
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;

export interface StatsSseHandlerOptions {
  /** Heartbeat comment period in milliseconds (default: 25s). */
  heartbeatIntervalMs?: number;
}

/**
 * Factory for stats SSE route handlers.
 * All three stats endpoints (docker, zfs, proxmox) share identical logic;
 * only the source string differs.
 */
export function createStatsSseHandler(
  source: StatsSource,
  options: StatsSseHandlerOptions = {},
) {
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  return async ({ request }: { request: Request }) => {
    const { authenticateSSE } = await import('@/lib/auth/sse-auth');
    const user = await authenticateSSE(request);
    if (!user) {
      return new Response('Unauthorized', { status: 401 });
    }

    await import('@/lib/server-init');
    const { statsPollService } = await import(
      '@/lib/database/subscription-service'
    );

    const encoder = new TextEncoder();
    let closed = false;

    const stream = new ReadableStream({
      start(controller) {
        // SSE heartbeat forces Nitro to flush response headers immediately
        controller.enqueue(encoder.encode(': ok\n\n'));

        let unsubscribe: () => void = () => {};

        // Tear down polling + close the stream once the consumer is gone
        // (either via request abort, or because controller.enqueue threw).
        const teardown = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // Already closed
          }
        };

        // Stats rows only flow while the poll service has data; a periodic
        // comment frame keeps proxies and Bun's idleTimeout from killing the
        // connection during quiet stretches.
        const heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(': ping\n\n'));
          } catch {
            teardown();
          }
        }, heartbeatIntervalMs);

        const sendData = (rows: unknown[]) => {
          if (closed) return;
          try {
            const message = `data: ${JSON.stringify(rows)}\n\n`;
            controller.enqueue(encoder.encode(message));
          } catch {
            teardown();
          }
        };

        const sendError = () => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`event: stats_error\ndata: {}\n\n`));
          } catch {
            teardown();
          }
        };

        try {
          unsubscribe = statsPollService.subscribe(source, sendData, sendError);
        } catch {
          sendError();
          teardown();
          return;
        }

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
