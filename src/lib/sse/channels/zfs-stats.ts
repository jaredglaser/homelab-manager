import { z } from 'zod';
import { defineSseChannel } from '@/lib/sse/define-sse-channel';
import { STATS_ERROR_EVENT } from '@/lib/sse/channels/stats-error-event';
import type { ZFSStatsRowRevived } from '@/types/zfs';

/**
 * Wire shape for one `zfs_stats` row. `time` accepts both `string` (the ISO
 * string every SSE frame and REST preload response actually carries over
 * the wire) and `Date` (the shape `ZFSStatsRow.time` also declares, since
 * `pg` hands the server a real `Date` for a `timestamptz` column before
 * it's ever serialized): this union keeps `preloadFn`'s declared return
 * type (`ZFSStatsRow[]`) assignable to this schema's inferred type without
 * a cast, while real wire traffic always matches the `string` branch.
 * `revive` below turns it into the epoch-ms number the live dashboard
 * (`routes/zfs.tsx` and everything downstream of its `useTimeSeriesStream`
 * output) works with.
 */
const zZFSStatsWireRow = z.object({
  time: z.union([z.string(), z.date()]),
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
  revive: (rows): ZFSStatsRowRevived[] =>
    rows.map((row) => ({ ...row, time: new Date(row.time).getTime() })),
});
