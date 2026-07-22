import { z } from 'zod';
import { defineSseChannel } from '@/lib/sse/define-sse-channel';
import { STATS_ERROR_EVENT } from '@/lib/sse/channels/stats-error-event';
import type { DockerStatsRowRevived } from '@/types/docker';

/**
 * Wire shape for one `docker_stats` row. `time` accepts both `string` (the
 * ISO string every SSE frame and REST preload response actually carries
 * over the wire) and `Date` (the shape `DockerStatsRow.time` also declares,
 * since `pg` hands the server a real `Date` for a `timestamptz` column
 * before it's ever serialized): this union keeps `preloadFn`'s declared
 * return type (`DockerStatsRow[]`) assignable to this schema's inferred
 * type without a cast, while real wire traffic always matches the `string`
 * branch. `revive` below turns it into the epoch-ms number the live
 * dashboard (`routes/docker.tsx` and everything downstream of its
 * `useTimeSeriesStream` output) works with, so `getKey`/`getTime` and every
 * chart/hierarchy consumer stop re-parsing the same string.
 */
const zDockerStatsWireRow = z.object({
  time: z.union([z.string(), z.date()]),
  host: z.string(),
  container_id: z.string(),
  container_name: z.string().nullable(),
  image: z.string().nullable(),
  cpu_percent: z.number().nullable(),
  memory_usage: z.number().nullable(),
  memory_limit: z.number().nullable(),
  memory_percent: z.number().nullable(),
  network_rx_bytes_per_sec: z.number().nullable(),
  network_tx_bytes_per_sec: z.number().nullable(),
  block_io_read_bytes_per_sec: z.number().nullable(),
  block_io_write_bytes_per_sec: z.number().nullable(),
});

const zDockerStatsWireRows = z.array(zDockerStatsWireRow);

export const dockerStatsChannel = defineSseChannel({
  url: '/api/docker-stats',
  errorEvent: STATS_ERROR_EVENT,
  schema: zDockerStatsWireRows,
  revive: (rows): DockerStatsRowRevived[] =>
    rows.map((row) => ({ ...row, time: new Date(row.time).getTime() })),
});
