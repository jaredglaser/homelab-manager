import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/proxmox-overview')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        await import('@/lib/server-init');
        const { proxmoxPollService } = await import(
          '@/lib/proxmox/proxmox-poll-service'
        );

        const encoder = new TextEncoder();
        let closed = false;

        const stream = new ReadableStream({
          start(controller) {
            const sendData = (overview: unknown) => {
              if (closed) return;
              try {
                const message = `data: ${JSON.stringify(overview)}\n\n`;
                controller.enqueue(encoder.encode(message));
              } catch {
                closed = true;
              }
            };

            const unsubscribe = proxmoxPollService.subscribe(sendData);

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
