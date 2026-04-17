import { createFileRoute } from '@tanstack/react-router';
import type { DockerInventoryBroadcastEvent } from '@/types/docker-inventory';

export const Route = createFileRoute('/api/docker-inventory')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        await import('@/lib/server-init');
        const { dockerInventoryBroadcastService } = await import(
          '@/lib/docker/docker-inventory-broadcast-service'
        );

        const encoder = new TextEncoder();
        let closed = false;

        const stream = new ReadableStream({
          start(controller) {
            const sendEvent = (event: DockerInventoryBroadcastEvent) => {
              if (closed) return;
              try {
                const payload = `data: ${JSON.stringify(event)}\n\n`;
                controller.enqueue(encoder.encode(payload));
              } catch (err) {
                if (!(err instanceof TypeError)) {
                  console.error('[docker-inventory SSE] Unexpected enqueue error:', err);
                }
                closed = true;
              }
            };

            const unsubscribe = dockerInventoryBroadcastService.subscribe(sendEvent);

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
      },
    },
  },
});
