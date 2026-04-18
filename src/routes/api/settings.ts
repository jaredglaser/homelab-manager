import { createFileRoute } from '@tanstack/react-router';
import { createBroadcastSseHandler } from '@/lib/sse/create-broadcast-sse-handler';
import type { SettingsSSEMessage } from '@/types/settings';

export const Route = createFileRoute('/api/settings')({
  server: {
    handlers: {
      GET: createBroadcastSseHandler<SettingsSSEMessage>({
        loadSubscribe: async () => {
          await import('@/lib/server-init');
          const { settingsBroadcastService } = await import(
            '@/lib/settings/settings-broadcast-service'
          );
          return (cb) => settingsBroadcastService.subscribe(cb);
        },
        serialize: (message) => `data: ${JSON.stringify(message)}\n\n`,
      }),
    },
  },
});
