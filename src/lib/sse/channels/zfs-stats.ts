import { z } from 'zod';
import { defineSseChannel } from '@/lib/sse/define-sse-channel';
import { STATS_ERROR_EVENT } from '@/lib/sse/channels/stats-error-event';

// time is epoch ms end to end: repository read path converts pg's timestamptz Date, so
// this schema matches ZFSStatsRow exactly and no revive step is needed.
const zZFSStatsWireRow = z.object({
  time: z.number(),
  host: z.string(),
  pool: z.string(),
  entity: z.string(),
  entity_type: z.string(),
  indent: z.number(),
  capacity_alloc: z.number().nullable(),
  capacity_free: z.number().nullable(),
  read_ops_per_sec: z.number().nullable(),
  write_ops_per_sec: z.number().nullable(),
  read_bytes_per_sec: z.number().nullable(),
  write_bytes_per_sec: z.number().nullable(),
  utilization_percent: z.number().nullable(),
});

const zZFSStatsWireRows = z.array(zZFSStatsWireRow);

export const zfsStatsChannel = defineSseChannel({
  url: '/api/zfs-stats',
  errorEvent: STATS_ERROR_EVENT,
  schema: zZFSStatsWireRows,
});
