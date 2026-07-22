import { z } from 'zod';
import { defineSseChannel } from '@/lib/sse/define-sse-channel';
import { STATS_ERROR_EVENT } from '@/lib/sse/channels/stats-error-event';
import type { ProxmoxStatsRowRevived } from '@/types/proxmox';

/**
 * Wire shape for one `proxmox_stats` row. `time` accepts both `string` (the
 * ISO string every SSE frame and REST preload response actually carries
 * over the wire) and `Date` (the shape `ProxmoxStatsRow.time` also
 * declares, since `pg` hands the server a real `Date` for a `timestamptz`
 * column before it's ever serialized): this union keeps `preloadFn`'s
 * declared return type (`ProxmoxStatsRow[]`) assignable to this schema's
 * inferred type without a cast, while real wire traffic always matches the
 * `string` branch. `revive` below turns it into the epoch-ms number the
 * live dashboard (`routes/proxmox.tsx` and everything downstream of its
 * `useTimeSeriesStream` output) works with.
 */
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
