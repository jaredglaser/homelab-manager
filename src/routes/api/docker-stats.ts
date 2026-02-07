import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/docker-stats')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Dynamic imports to avoid bundling server-only code
        await import('@/lib/server-init');
        const { subscriptionService } = await import(
          '@/lib/database/subscription-service'
        );
        const { statsCache } = await import('@/lib/cache/stats-cache');

        // Ensure subscription service is running
        await subscriptionService.start();

        const encoder = new TextEncoder();
        let closed = false;

        const stream = new ReadableStream({
          start(controller) {
            const sendData = (data: unknown) => {
              if (closed) return;
              try {
                const message = `data: ${JSON.stringify(data)}\n\n`;
                controller.enqueue(encoder.encode(message));
              } catch {
                closed = true;
              }
            };

            // Send initial data immediately
            const initialStats = statsCache.getDocker();
            sendData(initialStats);

            // Listen for updates
            const handler = (source: string) => {
              if (source === 'docker' && !closed) {
                const stats = statsCache.getDocker();
                sendData(stats);
              }
            };

            subscriptionService.on('stats_update', handler);

            // Handle client disconnect via abort signal
            request.signal.addEventListener('abort', () => {
              closed = true;
              subscriptionService.removeListener('stats_update', handler);
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
