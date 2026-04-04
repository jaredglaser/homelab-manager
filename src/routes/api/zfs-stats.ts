import { createFileRoute } from '@tanstack/react-router';
import { createStatsSseHandler } from '@/lib/sse/create-stats-sse-handler';

export const Route = createFileRoute('/api/zfs-stats')({
  server: {
    handlers: {
      GET: createStatsSseHandler('zfs'),
    },
  },
});
