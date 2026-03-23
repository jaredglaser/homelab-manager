import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/proxmox-stats')({
  server: {
    handlers: {
      GET: async ({ request }) => {
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

            const unsubscribe = statsPollService.subscribe('proxmox', sendData, sendError);

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
