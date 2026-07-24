import { z } from 'zod';
import { defineSseChannel } from '@/lib/sse/define-sse-channel';
import { STATS_ERROR_EVENT } from '@/lib/sse/channels/stats-error-event';

// time is epoch ms end to end: repository read path converts pg's timestamptz Date, so
// this schema matches DockerStatsRow exactly and no revive step is needed.
const zDockerStatsWireRow = z.object({
  time: z.number(),
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
});
