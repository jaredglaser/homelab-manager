import { createFileRoute } from '@tanstack/react-router';
import { createStatsSseHandler } from '@/lib/sse/create-stats-sse-handler';
import { proxmoxStatsChannel } from '@/lib/sse/channels/proxmox-stats';

export const Route = createFileRoute('/api/proxmox-stats')({
  server: {
    handlers: {
      GET: createStatsSseHandler('proxmox', proxmoxStatsChannel),
    },
  },
});
