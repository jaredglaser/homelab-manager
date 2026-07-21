import type { StatsSource } from '@/lib/database/subscription-service';

/**
 * Factory for stats SSE route handlers.
 * All three stats endpoints (docker, zfs, proxmox) share identical logic;
 * only the source string differs.
 */
export function createStatsSseHandler(source: StatsSource) {
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
          unsubscribe();
          try {
            controller.close();
          } catch {
            // Already closed
          }
        };

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
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
          return;
        }

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
