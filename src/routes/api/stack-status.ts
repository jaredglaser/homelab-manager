import { createFileRoute } from '@tanstack/react-router';
import { createBroadcastSseHandler } from '@/lib/sse/create-broadcast-sse-handler';
import { stackStatusChannel, serializeStackStatusEvent } from '@/lib/sse/channels/stack-status';
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
        serialize: serializeStackStatusEvent,
        errorEvent: stackStatusChannel.errorEvent,
      }),
    },
  },
});
