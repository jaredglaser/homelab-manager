import { createFileRoute } from '@tanstack/react-router';
import { createBroadcastSseHandler } from '@/lib/sse/create-broadcast-sse-handler';
import { ansibleRunsChannel, serializeAnsibleRunEvent } from '@/lib/sse/channels/ansible-runs';
import type { AnsibleBroadcastEvent } from '@/lib/ansible/run-broadcast-service';

export const Route = createFileRoute('/api/ansible-runs')({
  server: {
    handlers: {
      GET: createBroadcastSseHandler<AnsibleBroadcastEvent>({
        loadSubscribe: async () => {
          const { isAnsibleEnabled } = await import('@/lib/config/ansible-config');
          if (!isAnsibleEnabled()) {
            throw new Error('Ansible execution is disabled');
          }
          await import('@/lib/server-init');
          const { ansibleRunBroadcastService } = await import(
            '@/lib/ansible/run-broadcast-service'
          );
          return (cb) => ansibleRunBroadcastService.subscribe(cb);
        },
        serialize: serializeAnsibleRunEvent,
        errorEvent: ansibleRunsChannel.errorEvent,
      }),
    },
  },
});
