import { z } from 'zod';
import { defineSseChannel } from '@/lib/sse/define-sse-channel';
import { STATS_ERROR_EVENT } from '@/lib/sse/channels/stats-error-event';

// time is epoch ms end to end: repository read path converts pg's timestamptz Date, so
// this schema matches ProxmoxStatsRow exactly and no revive step is needed.
const zProxmoxStatsWireRow = z.object({
  time: z.number(),
  host: z.string(),
  entity_type: z.enum(['cluster', 'node', 'qemu', 'lxc', 'storage']),
  node: z.string().nullable(),
  entity_id: z.string(),
  entity_name: z.string().nullable(),
  status: z.string().nullable(),
  cpu: z.number().nullable(),
  max_cpu: z.number().nullable(),
  mem: z.number().nullable(),
  max_mem: z.number().nullable(),
  disk: z.number().nullable(),
  max_disk: z.number().nullable(),
  uptime: z.number().nullable(),
  vmid: z.number().nullable(),
  netin: z.number().nullable(),
  netout: z.number().nullable(),
  storage_type: z.string().nullable(),
  storage_content: z.string().nullable(),
  storage_avail: z.number().nullable(),
  storage_shared: z.boolean().nullable(),
  cluster_version: z.number().nullable(),
});

const zProxmoxStatsWireRows = z.array(zProxmoxStatsWireRow);

export const proxmoxStatsChannel = defineSseChannel({
  url: '/api/proxmox-stats',
  errorEvent: STATS_ERROR_EVENT,
  schema: zProxmoxStatsWireRows,
});
