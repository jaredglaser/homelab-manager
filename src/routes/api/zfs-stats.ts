import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/zfs-stats')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        await import('@/lib/server-init');
        const { notifyService } = await import(
          '@/lib/database/subscription-service'
        );
        const { databaseConnectionManager } = await import(
          '@/lib/clients/database-client'
        );
        const { loadDatabaseConfig } = await import(
          '@/lib/config/database-config'
        );
        const { StatsRepository } = await import(
          '@/lib/database/repositories/stats-repository'
        );

        await notifyService.start();

        const config = loadDatabaseConfig();
        const dbClient = await databaseConnectionManager.getClient(config);
        const repo = new StatsRepository(dbClient.getPool());

        const encoder = new TextEncoder();
        let closed = false;
        let eventsSent = 0;
        let lastSentTime = new Date(Date.now() - 1000);

        const stream = new ReadableStream({
          start(controller) {
            const sendData = (data: unknown) => {
              if (closed) return;
              try {
                const message = `data: ${JSON.stringify(data)}\n\n`;
                controller.enqueue(encoder.encode(message));
                eventsSent++;
              } catch {
                closed = true;
              }
            };

            const handler = async (payload: string) => {
              if (payload !== 'zfs' || closed) return;
              try {
                const rows = await repo.getZFSStatsSince(lastSentTime);
                if (rows.length > 0) {
                  lastSentTime = new Date(rows[rows.length - 1].time as string);
                  sendData(rows);
                }
              } catch {
                // Query failed — skip this cycle
              }
            };

            notifyService.on('stats_update', handler);

            request.signal.addEventListener('abort', () => {
              closed = true;
              notifyService.removeListener('stats_update', handler);
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
