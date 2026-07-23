import { createFileRoute } from '@tanstack/react-router';
import { createStatsSseHandler } from '@/lib/sse/create-stats-sse-handler';
import { zfsStatsChannel } from '@/lib/sse/channels/zfs-stats';

export const Route = createFileRoute('/api/zfs-stats')({
  server: {
    handlers: {
      GET: createStatsSseHandler('zfs', zfsStatsChannel),
    },
  },
});
