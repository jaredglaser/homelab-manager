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
        let lastSeq = await repo.getMaxZFSSeq();

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

            let processing = false;
            let pending = false;

            const processOnce = async () => {
              try {
                const rows = await repo.getZFSStatsSinceSeq(lastSeq);
                if (rows.length > 0) {
                  lastSeq = String((rows[rows.length - 1] as any).seq);
                  sendData(rows);
                }
              } catch {
                // Query failed — skip this cycle
              }
            };

            const handler = async (payload: string) => {
              if (closed) return;
              try {
                const parsed = JSON.parse(payload);
                if (parsed.source !== 'zfs') return;
              } catch {
                return;
              }
              if (processing) {
                pending = true;
                return;
              }
              processing = true;
              try {
                await processOnce();
                while (pending && !closed) {
                  pending = false;
                  await processOnce();
                }
              } finally {
                processing = false;
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
