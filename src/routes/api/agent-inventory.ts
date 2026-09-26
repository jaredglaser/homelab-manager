import { createFileRoute } from '@tanstack/react-router';
import { createBroadcastSseHandler } from '@/lib/sse/create-broadcast-sse-handler';
import { agentInventoryChannel } from '@/lib/sse/channels/agent-inventory';
import type { AgentInventorySseMessage } from '@/lib/sse/channels/agent-inventory';

export const Route = createFileRoute('/api/agent-inventory')({
  server: {
    handlers: {
      GET: createBroadcastSseHandler<AgentInventorySseMessage>({
        loadSubscribe: async () => {
          await import('@/lib/server-init');
          const { agentInventoryBroadcastService } = await import(
            '@/lib/agents/agent-inventory-broadcast-service'
          );
          return (cb) => agentInventoryBroadcastService.subscribe(cb);
        },
        serialize: (snapshot) => `data: ${JSON.stringify(snapshot)}\n\n`,
        errorEvent: agentInventoryChannel.errorEvent,
      }),
    },
  },
});
