import type { StatsSource } from '@/lib/database/subscription-service';

/**
 * Factory for stats SSE route handlers.
 * All three stats endpoints (docker, zfs, proxmox) share identical logic —
 * only the source string differs.
 */
export function createStatsSseHandler(source: StatsSource) {
  return async ({ request }: { request: Request }) => {
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

        const sendData = (rows: unknown[]) => {
          if (closed) return;
          try {
            const message = `data: ${JSON.stringify(rows)}\n\n`;
            controller.enqueue(encoder.encode(message));
          } catch {
            closed = true;
          }
        };

        const sendError = () => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`event: stats_error\ndata: {}\n\n`));
          } catch {
            closed = true;
          }
        };

        const unsubscribe = statsPollService.subscribe(source, sendData, sendError);

        request.signal.addEventListener('abort', () => {
          closed = true;
          unsubscribe();
          try {
            controller.close();
          } catch {
            // Already closed
          }
        });
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
