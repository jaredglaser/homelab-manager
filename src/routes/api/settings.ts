import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/settings')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        await import('@/lib/server-init');
        const { settingsBroadcastService } = await import(
          '@/lib/settings/settings-broadcast-service'
        );

        const encoder = new TextEncoder();
        let closed = false;

        const stream = new ReadableStream({
          start(controller) {
            const sendData = (message: unknown) => {
              if (closed) return;
              try {
                const data = `data: ${JSON.stringify(message)}\n\n`;
                controller.enqueue(encoder.encode(data));
              } catch {
                closed = true;
              }
            };

            const unsubscribe = settingsBroadcastService.subscribe(sendData);

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
