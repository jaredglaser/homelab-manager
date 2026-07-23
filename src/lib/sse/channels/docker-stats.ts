import { z } from 'zod';
import { defineSseChannel } from '@/lib/sse/define-sse-channel';
import { STATS_ERROR_EVENT } from '@/lib/sse/channels/stats-error-event';
import type { DockerStatsRowRevived } from '@/types/docker';

// time: z.date() too so DockerStatsRow[] (pg gives real Dates pre-serialization) stays
// assignable as preloadFn's return type without a cast; wire traffic is always string.
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
