import { createFileRoute } from '@tanstack/react-router';
import type { StackStatusRow } from '@/lib/database/repositories/stack-status-repository';

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
            const sendData = (entries: StackStatusRow[]) => {
              if (closed) return;
              try {
                const data = `data: ${JSON.stringify(entries)}\n\n`;
                controller.enqueue(encoder.encode(data));
              } catch (err) {
                if (!(err instanceof TypeError)) {
                  console.error('[stack-status SSE] Unexpected enqueue error:', err);
                }
                closed = true;
              }
            };

            const unsubscribe = stackStatusBroadcastService.subscribe(sendData);

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
