import { createFileRoute } from '@tanstack/react-router';
import { createStatsSseHandler } from '@/lib/sse/create-stats-sse-handler';
import { dockerStatsChannel } from '@/lib/sse/channels/docker-stats';

export const Route = createFileRoute('/api/docker-stats')({
  server: {
    handlers: {
      GET: createStatsSseHandler('docker', dockerStatsChannel),
    },
  },
});
