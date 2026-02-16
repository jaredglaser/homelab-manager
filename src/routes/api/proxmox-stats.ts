import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/proxmox-stats')({
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
        let eventsSent = 0;

        const debugLog = (message: string) => {
          if (subscriptionService.isDebugLogging) {
            console.log(message);
          }
        };

        const stream = new ReadableStream({
          start(controller) {
            const sendData = (data: unknown) => {
              if (closed) return;
              try {
                const message = `data: ${JSON.stringify(data)}\n\n`;
                controller.enqueue(encoder.encode(message));
                eventsSent++;
              } catch {
                debugLog(`[SSE:proxmox-stats] Enqueue failed after ${eventsSent} events`);
                closed = true;
              }
            };

            // Send initial data immediately
            const initialStats = statsCache.getProxmox();
            debugLog(`[SSE:proxmox-stats] Client connected, sending ${initialStats.length} initial stats`);
            sendData(initialStats);

            // Listen for updates
            const handler = (source: string) => {
              if (source === 'proxmox' && !closed) {
                const stats = statsCache.getProxmox();
                sendData(stats);
              }
            };

            subscriptionService.on('stats_update', handler);

            // Handle client disconnect via abort signal
            request.signal.addEventListener('abort', () => {
              debugLog(`[SSE:proxmox-stats] Client disconnected after ${eventsSent} events`);
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
