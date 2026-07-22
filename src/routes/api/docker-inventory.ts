import { createFileRoute } from '@tanstack/react-router';
import { createBroadcastSseHandler } from '@/lib/sse/create-broadcast-sse-handler';
import { dockerInventoryChannel } from '@/lib/sse/channels/docker-inventory';
import type { DockerInventoryBroadcastEvent } from '@/types/docker-inventory';

export const Route = createFileRoute('/api/docker-inventory')({
  server: {
    handlers: {
      GET: createBroadcastSseHandler<DockerInventoryBroadcastEvent>({
        loadSubscribe: async () => {
          await import('@/lib/server-init');
          const { dockerInventoryBroadcastService } = await import(
            '@/lib/docker/docker-inventory-broadcast-service'
          );
          return (cb) => dockerInventoryBroadcastService.subscribe(cb);
        },
        serialize: (event) => `data: ${JSON.stringify(event)}\n\n`,
        errorEvent: dockerInventoryChannel.errorEvent,
      }),
    },
  },
});
