import { createFileRoute } from '@tanstack/react-router';
import { createBroadcastSseHandler } from '@/lib/sse/create-broadcast-sse-handler';
import { findingsChannel, serializeFindingsEvent } from '@/lib/sse/channels/findings';
import type { FindingsBroadcastEvent } from '@/lib/findings/findings-broadcast-service';

export const Route = createFileRoute('/api/findings')({
  server: {
    handlers: {
      GET: createBroadcastSseHandler<FindingsBroadcastEvent>({
        loadSubscribe: async () => {
          await import('@/lib/server-init');
          const { findingsBroadcastService } = await import('@/lib/findings/findings-broadcast-service');
          return (cb) => findingsBroadcastService.subscribe(cb);
        },
        serialize: serializeFindingsEvent,
        errorEvent: findingsChannel.errorEvent,
      }),
    },
  },
});
