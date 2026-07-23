import { createFileRoute } from '@tanstack/react-router';
import { createBroadcastSseHandler } from '@/lib/sse/create-broadcast-sse-handler';
import { stackStatusChannel } from '@/lib/sse/channels/stack-status';
import type { StackBroadcastEvent } from '@/lib/stacks/stack-status-broadcast-service';

export const Route = createFileRoute('/api/stack-status')({
  server: {
    handlers: {
      GET: createBroadcastSseHandler<StackBroadcastEvent>({
        loadSubscribe: async () => {
          await import('@/lib/server-init');
          const { stackStatusBroadcastService } = await import(
            '@/lib/stacks/stack-status-broadcast-service'
          );
          return (cb) => stackStatusBroadcastService.subscribe(cb);
        },
        serialize: (event) => {
          if (event.type === 'deploy_changed') {
            const payload = { type: 'deploy_changed', stack: event.stack, host: event.host };
            return `data: ${JSON.stringify(payload)}\n\n`;
          }
          return `data: ${JSON.stringify(event.entries)}\n\n`;
        },
        errorEvent: stackStatusChannel.errorEvent,
      }),
    },
  },
});
