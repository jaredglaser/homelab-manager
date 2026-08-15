import { z } from 'zod';
import yaml from 'js-yaml';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpToolContext } from '@/lib/mcp/context';
import { zEntityId, zTime, parseEntityId, resolveWindow, hasScope, iso, McpToolError, ok, fail } from '@/lib/mcp/shared';
import { getContainerSnapshot } from '@/lib/mcp/queries';
import { StatsRepository, resolveStatsTier } from '@/lib/database/repositories/stats-repository';
import type { DockerStatsRow } from '@/types/docker';
import { readFileFromRepo, FileNotFoundError } from '@/lib/git/repo';
import { loadGitConfig } from '@/lib/config/git-config';
import { MANIFEST, composePath } from '@/lib/stacks/stack-repo-layout';
import { parseManifest } from '@/lib/git/manifest';

const STATS_SCOPE = 'mcp:stats:read';
const STACKS_SCOPE = 'mcp:stacks:read';

const GET_STATS_DEFAULT_SINCE_SECONDS = 60 * 60;
const GET_STATS_MAX_SPAN_SECONDS = 365 * 24 * 60 * 60;
const STATS_POINTS_MIN = 10;
const STATS_POINTS_MAX = 300;
const STATS_POINTS_DEFAULT = 60;

const STACK_COMPOSE_MAX_BYTES_MIN = 1024;
const STACK_COMPOSE_MAX_BYTES_MAX = 65536;
const STACK_COMPOSE_MAX_BYTES_DEFAULT = 32768;
const STACK_COMPOSE_DEFAULT_REF = 'HEAD';

const METRIC_KEYS = [
  'cpuPercent',
  'memoryBytes',
  'memoryPercent',
  'netRxBytesPerSec',
  'netTxBytesPerSec',
  'blockReadBytesPerSec',
  'blockWriteBytesPerSec',
] as const;

type MetricKey = (typeof METRIC_KEYS)[number];

const METRIC_UNITS: Record<MetricKey, string> = {
  cpuPercent: 'percent_of_one_core',
  memoryBytes: 'bytes',
  memoryPercent: 'percent_of_limit',
  netRxBytesPerSec: 'bytes_per_second',
  netTxBytesPerSec: 'bytes_per_second',
  blockReadBytesPerSec: 'bytes_per_second',
  blockWriteBytesPerSec: 'bytes_per_second',
};

const metricSummarySchema = z.object({
  min: z.number().nullable(),
  avg: z.number().nullable(),
  max: z.number().nullable(),
  p95: z.number().nullable(),
  unit: z.string(),
});

const statsPointSchema = z.object({
  at: z.string(),
  cpuPercent: z.number().nullable(),
  memoryBytes: z.number().nullable(),
  memoryPercent: z.number().nullable(),
  netRxBytesPerSec: z.number().nullable(),
  netTxBytesPerSec: z.number().nullable(),
  blockReadBytesPerSec: z.number().nullable(),
  blockWriteBytesPerSec: z.number().nullable(),
});

function metricValue(row: DockerStatsRow, key: MetricKey): number | null {
  switch (key) {
    case 'cpuPercent':
      return row.cpu_percent;
    case 'memoryBytes':
      return row.memory_usage;
    case 'memoryPercent':
      return row.memory_percent;
    case 'netRxBytesPerSec':
      return row.network_rx_bytes_per_sec;
    case 'netTxBytesPerSec':
      return row.network_tx_bytes_per_sec;
    case 'blockReadBytesPerSec':
      return row.block_io_read_bytes_per_sec;
    case 'blockWriteBytesPerSec':
      return row.block_io_write_bytes_per_sec;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

function summarizeMetric(rows: DockerStatsRow[], key: MetricKey) {
  const values = rows.map((row) => metricValue(row, key)).filter((v): v is number => v !== null);
  if (values.length === 0) {
    return { min: null, avg: null, max: null, p95: null, unit: METRIC_UNITS[key] };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((acc, v) => acc + v, 0);
  return {
    min: sorted[0]!,
    avg: sum / values.length,
    max: sorted[sorted.length - 1]!,
    p95: percentile(sorted, 0.95),
    unit: METRIC_UNITS[key],
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1]! + sorted[mid]!) / 2;
  return sorted[mid]!;
}

function medianResolutionSeconds(rows: DockerStatsRow[]): number {
  if (rows.length < 2) return 0;
  const diffs: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    diffs.push((rows[i]!.time - rows[i - 1]!.time) / 1000);
  }
  return median(diffs);
}

function lastMemoryLimitBytes(rows: DockerStatsRow[]): number | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const limit = rows[i]!.memory_limit;
    if (limit !== null) return limit;
  }
  return null;
}

function toStatsPoint(row: DockerStatsRow) {
  return {
    at: iso(row.time),
    cpuPercent: row.cpu_percent,
    memoryBytes: row.memory_usage,
    memoryPercent: row.memory_percent,
    netRxBytesPerSec: row.network_rx_bytes_per_sec,
    netTxBytesPerSec: row.network_tx_bytes_per_sec,
    blockReadBytesPerSec: row.block_io_read_bytes_per_sec,
    blockWriteBytesPerSec: row.block_io_write_bytes_per_sec,
  };
}

function registerGetStats(server: McpServer, ctx: McpToolContext): void {
  server.registerTool(
    'get_stats',
    {
      title: 'Get Stats',
      description:
        "Read CPU, memory, network and block IO for one container over a time window, to answer whether it was under resource pressure when it misbehaved. Returns a `summary` with the minimum, mean, maximum and 95th percentile of each metric, plus up to `points` downsampled samples so you can see the shape without reading thousands of rows. Resolution degrades with age: a window inside the last 24 hours can resolve to seconds, older windows come from one-minute or one-hour rollups, and `resolutionSeconds` tells you what you actually got, so do not read a single-second spike out of hourly data. Metrics live in the monitor's database, so this answers even when the host is unreachable. `cpuPercent` can exceed 100 on a multi-core host: it is percent of one core.",
      inputSchema: {
        entityId: zEntityId,
        since: zTime.optional(),
        until: zTime.optional(),
        points: z.number().int().min(STATS_POINTS_MIN).max(STATS_POINTS_MAX).default(STATS_POINTS_DEFAULT),
        includePoints: z.boolean().default(true),
      },
      outputSchema: {
        entityId: z.string(),
        window: z.object({ from: z.string(), to: z.string() }),
        tier: z.string(),
        resolutionSeconds: z.number(),
        sampleCount: z.number(),
        summary: z.object({
          cpuPercent: metricSummarySchema,
          memoryBytes: metricSummarySchema,
          memoryPercent: metricSummarySchema,
          netRxBytesPerSec: metricSummarySchema,
          netTxBytesPerSec: metricSummarySchema,
          blockReadBytesPerSec: metricSummarySchema,
          blockWriteBytesPerSec: metricSummarySchema,
        }),
        memoryLimitBytes: z.number().nullable(),
        points: z.array(statsPointSchema),
        summaryBasis: z.literal('bucketed'),
        note: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ entityId, since, until, points, includePoints }) => {
      try {
        const { host, containerId } = parseEntityId(entityId);
        const window = resolveWindow(
          { since, until },
          { defaultSinceSeconds: GET_STATS_DEFAULT_SINCE_SECONDS, maxSpanSeconds: GET_STATS_MAX_SPAN_SECONDS },
        );

        const rows = await new StatsRepository(ctx.pool).getDockerStatsForContainer(
          [containerId],
          host,
          window.from,
          window.to,
          points,
        );

        const windowStartAgeSeconds = Math.max(0, (Date.now() - window.from.getTime()) / 1000);
        const tier = resolveStatsTier('docker_stats', window.spanSeconds, windowStartAgeSeconds);

        const summary = Object.fromEntries(METRIC_KEYS.map((key) => [key, summarizeMetric(rows, key)])) as Record<
          MetricKey,
          ReturnType<typeof summarizeMetric>
        >;

        const structured: Record<string, unknown> = {
          entityId,
          window: { from: iso(window.from), to: iso(window.to) },
          tier: tier.relation,
          resolutionSeconds: medianResolutionSeconds(rows),
          sampleCount: rows.length,
          summary,
          memoryLimitBytes: lastMemoryLimitBytes(rows),
          points: includePoints ? rows.map(toStatsPoint) : [],
          summaryBasis: 'bucketed',
        };

        if (rows.length === 0) {
          structured.note = 'No stats rows in this window; the retention tier for this window may have dropped them.';
        }

        return ok(structured);
      } catch (err) {
        if (err instanceof McpToolError) return fail(err);
        throw err;
      }
    },
  );
}

function truncateComposeContent(content: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(content, 'utf8');
  if (buf.byteLength <= maxBytes) {
    return { text: content, truncated: false };
  }
  const sliceText = buf.subarray(0, maxBytes).toString('utf8');
  const lastNewline = sliceText.lastIndexOf('\n');
  const text = lastNewline === -1 ? sliceText : sliceText.slice(0, lastNewline);
  return { text, truncated: true };
}

function extractServiceNames(content: string): { services: string[]; parseError?: string } {
  try {
    const parsed = yaml.load(content) as { services?: Record<string, unknown> } | null | undefined;
    if (parsed && typeof parsed === 'object' && parsed.services && typeof parsed.services === 'object') {
      return { services: Object.keys(parsed.services) };
    }
    return { services: [] };
  } catch (err) {
    return { services: [], parseError: err instanceof Error ? err.message : String(err) };
  }
}

function registerGetStackCompose(server: McpServer, ctx: McpToolContext): void {
  server.registerTool(
    'get_stack_compose',
    {
      title: 'Get Stack Compose',
      description:
        "Read a stack's docker-compose.yml as it exists in the monitor's git repository. Use it to see what a container is supposed to be running: image tag, environment variable names, ports, volumes, restart policy, healthcheck, and dependencies between services. Pass `ref` with a `commitSha` from `get_deploy_history` to read the file as it stood at that deploy, which is how you tell whether a configuration change caused an incident. Identify the stack by a container's entity id or by name. Secret values are never stored in this file; only the variable names appear.",
      inputSchema: {
        entityId: zEntityId.optional(),
        stack: z.string().min(1).optional(),
        ref: z.string().min(4).max(64).default(STACK_COMPOSE_DEFAULT_REF),
        maxBytes: z
          .number()
          .int()
          .min(STACK_COMPOSE_MAX_BYTES_MIN)
          .max(STACK_COMPOSE_MAX_BYTES_MAX)
          .default(STACK_COMPOSE_MAX_BYTES_DEFAULT),
      },
      outputSchema: {
        stack: z.string(),
        ref: z.string(),
        path: z.string(),
        content: z.string(),
        bytes: z.number(),
        truncated: z.boolean(),
        services: z.array(z.string()),
        parseError: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ entityId, stack, ref, maxBytes }) => {
      try {
        const providedCount = [entityId, stack].filter((v) => v !== undefined).length;
        if (providedCount !== 1) {
          throw new McpToolError('unknown_stack', 'Provide exactly one of entityId or stack.');
        }

        let resolvedStack: string;
        if (entityId !== undefined) {
          const { host, containerId } = parseEntityId(entityId);
          const snapshot = await getContainerSnapshot(ctx.pool, host, containerId);
          if (!snapshot || snapshot.eventType !== 'upsert' || !snapshot.composeProject) {
            throw new McpToolError('unknown_stack', `Container ${entityId} is not part of a managed stack.`);
          }
          resolvedStack = snapshot.composeProject;
        } else {
          resolvedStack = stack!;
        }

        const repoPath = loadGitConfig().repoPath;

        let manifestContent: string;
        try {
          manifestContent = await readFileFromRepo(repoPath, MANIFEST, ref);
        } catch (err) {
          if (err instanceof FileNotFoundError) {
            throw new McpToolError('unknown_stack', `No manifest found at ref "${ref}".`);
          }
          throw err;
        }

        const manifest = parseManifest(manifestContent);
        if (!manifest.stacks[resolvedStack]) {
          throw new McpToolError('unknown_stack', `Stack "${resolvedStack}" is not in the manifest.`);
        }

        let content: string;
        try {
          content = await readFileFromRepo(repoPath, composePath(resolvedStack), ref);
        } catch (err) {
          if (err instanceof FileNotFoundError) {
            throw new McpToolError('unknown_stack', `Stack "${resolvedStack}" has no compose file at ref "${ref}".`);
          }
          throw err;
        }

        const truncatedResult = truncateComposeContent(content, maxBytes);
        const { services, parseError } = extractServiceNames(content);

        const structured: Record<string, unknown> = {
          stack: resolvedStack,
          ref,
          path: composePath(resolvedStack),
          content: truncatedResult.text,
          bytes: Buffer.byteLength(truncatedResult.text, 'utf8'),
          truncated: truncatedResult.truncated,
          services,
        };
        if (parseError !== undefined) {
          structured.parseError = parseError;
        }

        return ok(structured);
      } catch (err) {
        if (err instanceof McpToolError) return fail(err);
        throw err;
      }
    },
  );
}

export function registerStatsTools(server: McpServer, ctx: McpToolContext): void {
  if (hasScope(ctx.scopes, STATS_SCOPE)) {
    registerGetStats(server, ctx);
  }
  if (hasScope(ctx.scopes, STACKS_SCOPE)) {
    registerGetStackCompose(server, ctx);
  }
}
