import { createFileRoute } from '@tanstack/react-router';
import type { StackBroadcastEvent } from '@/lib/stacks/stack-status-broadcast-service';

export const Route = createFileRoute('/api/stack-status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        await import('@/lib/server-init');
        const { stackStatusBroadcastService } = await import(
          '@/lib/stacks/stack-status-broadcast-service'
        );

        const encoder = new TextEncoder();
        let closed = false;

        const stream = new ReadableStream({
          start(controller) {
            const sendEvent = (event: StackBroadcastEvent) => {
              if (closed) return;
              try {
                if (event.type === 'deploy_changed') {
                  const payload = `data: ${JSON.stringify({ type: 'deploy_changed', stack: event.stack, host: event.host })}\n\n`;
                  controller.enqueue(encoder.encode(payload));
                } else {
                  const payload = `data: ${JSON.stringify(event.entries)}\n\n`;
                  controller.enqueue(encoder.encode(payload));
                }
              } catch (err) {
                if (!(err instanceof TypeError)) {
                  console.error('[stack-status SSE] Unexpected enqueue error:', err);
                }
                closed = true;
              }
            };

            const unsubscribe = stackStatusBroadcastService.subscribe(sendEvent);

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
