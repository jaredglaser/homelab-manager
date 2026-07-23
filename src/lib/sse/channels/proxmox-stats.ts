import { z } from 'zod';
import { defineSseChannel } from '@/lib/sse/define-sse-channel';
import { STATS_ERROR_EVENT } from '@/lib/sse/channels/stats-error-event';
import type { ProxmoxStatsRowRevived } from '@/types/proxmox';

// time: z.date() too so ProxmoxStatsRow[] (pg gives real Dates pre-serialization) stays
// assignable as preloadFn's return type without a cast; wire traffic is always string.
const zProxmoxStatsWireRow = z.object({
  time: z.union([z.string(), z.date()]),
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
  revive: (rows): ProxmoxStatsRowRevived[] =>
    rows.map((row) => ({ ...row, time: new Date(row.time).getTime() })),
});
