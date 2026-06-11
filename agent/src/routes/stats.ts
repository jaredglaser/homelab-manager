import type { Readable } from 'node:stream';
import type Dockerode from 'dockerode';

const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 10;
const DEFAULT_MAX_STAT_STREAMS = 300;

export interface StatsStreamOptions {
  refreshIntervalMs?: number;
  pollIntervalMs?: number;
  /** Close the stream after this many consecutive refresh failures (default: 10). */
  maxConsecutiveFailures?: number;
  /** Cap on concurrent per-container stat streams (default: AGENT_MAX_STAT_STREAMS env var or 300). */
  maxStatStreams?: number;
}

/**
 * Resolve the per-container stat stream cap from AGENT_MAX_STAT_STREAMS.
 * Each streamed container holds one open connection to dockerd, so an
 * unbounded fan-out on a host with hundreds of containers can exhaust
 * dockerd connection limits. Invalid values fall back to the default.
 */
export function resolveMaxStatStreams(envValue = process.env.AGENT_MAX_STAT_STREAMS): number {
  if (!envValue) return DEFAULT_MAX_STAT_STREAMS;
  const parsed = Number(envValue);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(`Invalid AGENT_MAX_STAT_STREAMS: '${envValue}'. Using default ${DEFAULT_MAX_STAT_STREAMS}.`);
    return DEFAULT_MAX_STAT_STREAMS;
  }
  return parsed;
}

/** Flat computed metrics matching the worker's AgentStatsEvent interface. */
export interface ComputedStats {
  containerId: string;
  containerName: string;
  image: string;
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRxBytesPerSec: number;
  networkTxBytesPerSec: number;
  blockReadBytesPerSec: number;
  blockWriteBytesPerSec: number;
  timestamp: string;
}

/** Tracked state from the previous stats frame for rate calculations. */
interface PreviousFrame {
  timestamp: string;
  networkRxBytes: number;
  networkTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
}

/** Safe number: returns 0 if the value is NaN, Infinity, or not a finite number. */
function safeNum(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Check if a Dockerode error indicates the container no longer exists (404 or 409). */
export function isContainerGone(error: Error): boolean {
  return /\(HTTP code (404|409)\)/.test(error.message);
}

/** Sum rx_bytes and tx_bytes across all network interfaces. */
function sumNetworkBytes(networks: Record<string, { rx_bytes?: number; tx_bytes?: number }> | undefined): { rx: number; tx: number } {
  if (!networks || typeof networks !== 'object') return { rx: 0, tx: 0 };
  let rx = 0;
  let tx = 0;
  for (const iface of Object.values(networks)) {
    rx += iface.rx_bytes ?? 0;
    tx += iface.tx_bytes ?? 0;
  }
  return { rx, tx };
}

/** Sum read and write bytes from blkio_stats.io_service_bytes_recursive. */
function sumBlockIOBytes(blkioStats: { io_service_bytes_recursive?: Array<{ op: string; value: number }> } | undefined): { read: number; write: number } {
  const entries = blkioStats?.io_service_bytes_recursive;
  if (!Array.isArray(entries)) return { read: 0, write: 0 };
  let read = 0;
  let write = 0;
  for (const entry of entries) {
    if (entry.op === 'read' || entry.op === 'Read') read += entry.value ?? 0;
    if (entry.op === 'write' || entry.op === 'Write') write += entry.value ?? 0;
  }
  return { read, write };
}

/**
 * Compute flat metrics from a raw Docker stats frame.
 * Rate fields (network, block I/O) require a previous frame; first frame emits 0.
 */
export function computeMetrics(
  containerId: string,
  containerName: string,
  image: string,
  stats: Record<string, any>,
  prevFrames: Map<string, PreviousFrame>,
): ComputedStats {
  // CPU (Docker CLI formula)
  const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) - (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta = (stats.cpu_stats?.system_cpu_usage ?? 0) - (stats.precpu_stats?.system_cpu_usage ?? 0);
  const onlineCpus = stats.cpu_stats?.online_cpus ?? 1;
  const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus * 100 : 0;

  // Memory
  const memUsageRaw = stats.memory_stats?.usage ?? 0;
  const memCache = stats.memory_stats?.stats?.cache ?? 0;
  const memoryUsage = Math.max(0, memUsageRaw - memCache);
  const memoryLimit = stats.memory_stats?.limit ?? 0;
  const memoryPercent = memoryLimit > 0 ? (memoryUsage / memoryLimit) * 100 : 0;

  // Network totals
  const net = sumNetworkBytes(stats.networks);

  // Block I/O totals
  const blk = sumBlockIOBytes(stats.blkio_stats);

  // Timestamp
  const timestamp: string = stats.read ?? new Date().toISOString();

  // Rate calculations
  let networkRxBytesPerSec = 0;
  let networkTxBytesPerSec = 0;
  let blockReadBytesPerSec = 0;
  let blockWriteBytesPerSec = 0;

  const prev = prevFrames.get(containerId);
  if (prev) {
    const timeDeltaSec = (new Date(timestamp).getTime() - new Date(prev.timestamp).getTime()) / 1000;
    if (timeDeltaSec > 0) {
      networkRxBytesPerSec = Math.max(0, (net.rx - prev.networkRxBytes) / timeDeltaSec);
      networkTxBytesPerSec = Math.max(0, (net.tx - prev.networkTxBytes) / timeDeltaSec);
      blockReadBytesPerSec = Math.max(0, (blk.read - prev.blockReadBytes) / timeDeltaSec);
      blockWriteBytesPerSec = Math.max(0, (blk.write - prev.blockWriteBytes) / timeDeltaSec);
    }
  }

  // Store current frame for next rate calculation
  prevFrames.set(containerId, {
    timestamp,
    networkRxBytes: net.rx,
    networkTxBytes: net.tx,
    blockReadBytes: blk.read,
    blockWriteBytes: blk.write,
  });

  return {
    containerId,
    containerName,
    image,
    cpuPercent: safeNum(cpuPercent),
    memoryUsage: safeNum(memoryUsage),
    memoryLimit: safeNum(memoryLimit),
    memoryPercent: safeNum(memoryPercent),
    networkRxBytesPerSec: safeNum(networkRxBytesPerSec),
    networkTxBytesPerSec: safeNum(networkTxBytesPerSec),
    blockReadBytesPerSec: safeNum(blockReadBytesPerSec),
    blockWriteBytesPerSec: safeNum(blockWriteBytesPerSec),
    timestamp,
  };
}

/** Shared mutable state for a single SSE stats session. */
interface StreamContext {
  closed: boolean;
  readonly encoder: TextEncoder;
  readonly containerStreams: Map<string, Readable>;
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
}

/** Enqueue an SSE message, silently swallowing enqueue-after-close TypeError. */
function sendSSE(ctx: StreamContext, data: string, event?: string): void {
  if (ctx.closed) return;
  try {
    const prefix = event ? `event: ${event}\n` : '';
    ctx.controller.enqueue(ctx.encoder.encode(`${prefix}data: ${data}\n\n`));
  } catch (err) {
    if (!(err instanceof TypeError)) console.error('Unexpected error during SSE enqueue:', err);
  }
}

/** Enqueue a JSON error payload as an SSE event. */
function sendErrorSSE(ctx: StreamContext, payload: Record<string, unknown>, event = 'container-error'): void {
  sendSSE(ctx, JSON.stringify(payload), event);
}

/** Destroy all tracked container streams and clear the map. */
function destroyAllStreams(containerStreams: Map<string, Readable>): void {
  for (const s of containerStreams.values()) {
    if (typeof s.destroy === 'function') s.destroy();
  }
  containerStreams.clear();
}

/**
 * Parse newline-delimited JSON stats from a Docker stats stream chunk.
 * Calls `onStats` for each complete JSON frame.
 */
function parseStatsChunks(
  buffer: string,
  chunk: Buffer,
  onStats: (stats: unknown) => void,
  onError: () => void,
): string {
  buffer += chunk.toString();

  let newlineIdx;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      onError();
      continue;
    }
    onStats(parsed);
  }
  return buffer;
}

/** Open a Docker stats stream for a single container and wire up SSE forwarding. */
function openContainerStream(
  ctx: StreamContext,
  docker: Dockerode,
  containerInfo: Dockerode.ContainerInfo,
  prevFrames: Map<string, PreviousFrame>,
): void {
  const id = containerInfo.Id;
  const name = containerInfo.Names[0]?.replace(/^\//, '') ?? id;
  const image = containerInfo.Image;
  const container = docker.getContainer(id);

  container.stats({ stream: true }).then((statsStream) => {
    // @types/dockerode 4.0.1 types stats() stream result as any; cast required to use Readable API
    const readable = statsStream as unknown as Readable;
    if (ctx.closed) {
      if (typeof readable.destroy === 'function') readable.destroy();
      return;
    }
    ctx.containerStreams.set(id, readable);

    let buffer = '';
    readable.on('data', (chunk: Buffer) => {
      if (ctx.closed) return;
      buffer = parseStatsChunks(buffer, chunk, (stats) => {
        sendSSE(ctx, JSON.stringify(computeMetrics(id, name, image, stats as Record<string, any>, prevFrames)));
      }, () => {
        console.error(`Malformed stats JSON from container ${id}, skipping frame`);
      });
    });

    readable.on('error', (error: Error) => {
      if (isContainerGone(error)) {
        // Container removed while streaming: normal lifecycle, not an error
        ctx.containerStreams.delete(id);
        return;
      }
      console.error(`Stats stream error for container ${id}:`, error.message);
      sendErrorSSE(ctx, { containerId: id, error: error.message });
      ctx.containerStreams.delete(id);
    });

    readable.on('end', () => {
      ctx.containerStreams.delete(id);
    });
  }).catch((error: Error) => {
    if (isContainerGone(error)) return; // Container removed between list and stats (race condition)
    console.error(`Failed to open stats stream for container ${id}:`, error.message);
    sendErrorSSE(ctx, { containerId: id, error: error.message });
  });
}

/**
 * Diff current containers against the previous set:
 * - Destroy streams for removed containers
 * - Open streams for new containers
 * - Emit a `containers` SSE event with the current ID list
 */
function reconcileContainers(
  ctx: StreamContext,
  docker: Dockerode,
  previous: Dockerode.ContainerInfo[],
  current: Dockerode.ContainerInfo[],
  prevFrames: Map<string, PreviousFrame>,
): void {
  const currentIds = new Set(current.map(c => c.Id));
  const previousIds = new Set(previous.map(c => c.Id));

  for (const prevId of previousIds) {
    if (!currentIds.has(prevId)) {
      const stale = ctx.containerStreams.get(prevId);
      if (stale && typeof stale.destroy === 'function') stale.destroy();
      ctx.containerStreams.delete(prevId);
      prevFrames.delete(prevId);
    }
  }

  for (const c of current) {
    if (!previousIds.has(c.Id)) openContainerStream(ctx, docker, c, prevFrames);
  }

  sendSSE(ctx, JSON.stringify({ ids: [...currentIds] }), 'containers');
}

/**
 * Truncate the container list to the stat stream cap. When over the cap,
 * only the first `maxStatStreams` containers (Docker list order) get streams
 * and a `stream-cap-exceeded` SSE event reports the truncation so the worker
 * can surface the gap instead of silently missing containers.
 */
function capContainers(
  ctx: StreamContext,
  containers: Dockerode.ContainerInfo[],
  maxStatStreams: number,
): Dockerode.ContainerInfo[] {
  if (containers.length <= maxStatStreams) return containers;
  const skipped = containers.length - maxStatStreams;
  console.error(`Stat stream cap exceeded: streaming ${maxStatStreams} of ${containers.length} containers (${skipped} skipped). Raise AGENT_MAX_STAT_STREAMS to stream more.`);
  sendErrorSSE(ctx, {
    error: `Stat stream cap exceeded: streaming ${maxStatStreams} of ${containers.length} containers`,
    maxStatStreams,
    totalContainers: containers.length,
    skippedContainers: skipped,
  }, 'stream-cap-exceeded');
  return containers.slice(0, maxStatStreams);
}

/** Try to close a ReadableStream controller, ignoring errors if already closed. */
function tryCloseController(controller: ReadableStreamDefaultController<Uint8Array>): void {
  try {
    controller.close();
  } catch (err) {
    if (!(err instanceof TypeError)) console.error('Unexpected error closing controller:', err);
  }
}

/**
 * Attempt a single container-list refresh. Returns the updated container list
 * on success, or `null` on failure (after logging and sending an SSE error).
 */
async function tryRefreshContainers(
  ctx: StreamContext,
  docker: Dockerode,
  previous: Dockerode.ContainerInfo[],
  failureCount: number,
  maxFailures: number,
  prevFrames: Map<string, PreviousFrame>,
  maxStatStreams: number,
): Promise<{ containers: Dockerode.ContainerInfo[]; shouldBreak: boolean } | null> {
  try {
    const current = capContainers(ctx, await docker.listContainers({ all: false }), maxStatStreams);
    if (ctx.closed) return { containers: current, shouldBreak: true };
    reconcileContainers(ctx, docker, previous, current, prevFrames);
    return { containers: current, shouldBreak: false };
  } catch (error) {
    const count = failureCount + 1;
    console.error(`Failed to refresh container list (${count}/${maxFailures}):`, error);
    const msg = error instanceof Error ? error.message : String(error);
    sendErrorSSE(ctx, { error: msg, type: 'refresh_failed' });

    if (count >= maxFailures) {
      console.error('Max consecutive refresh failures reached, closing stats stream');
      sendSSE(ctx, JSON.stringify({ error: 'Docker daemon unreachable, stream closed' }), 'error');
    }
    return null;
  }
}

/** Run the poll-and-refresh loop, emitting SSE events for container stats. */
async function runStatsLoop(
  ctx: StreamContext,
  docker: Dockerode,
  pollIntervalMs: number,
  refreshIntervalMs: number,
  maxConsecutiveFailures: number,
  maxStatStreams: number,
): Promise<void> {
  const prevFrames = new Map<string, PreviousFrame>();
  let containers = capContainers(ctx, await docker.listContainers({ all: false }), maxStatStreams);
  if (ctx.closed) return;
  let lastRefresh = Date.now();
  let consecutiveFailures = 0;

  for (const c of containers) {
    openContainerStream(ctx, docker, c, prevFrames);
  }

  sendSSE(ctx, JSON.stringify({ ids: containers.map(c => c.Id) }), 'containers');

  while (!ctx.closed) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    if (ctx.closed) break;

    const now = Date.now();
    if (now - lastRefresh < refreshIntervalMs) continue;
    lastRefresh = now;

    const result = await tryRefreshContainers(ctx, docker, containers, consecutiveFailures, maxConsecutiveFailures, prevFrames, maxStatStreams);
    if (!result) {
      consecutiveFailures++;
      if (consecutiveFailures >= maxConsecutiveFailures) break;
      continue;
    }
    if (result.shouldBreak) break;
    containers = result.containers;
    consecutiveFailures = 0;
  }

  destroyAllStreams(ctx.containerStreams);
  ctx.closed = true;
  tryCloseController(ctx.controller);
}

/**
 * Create an SSE Response that streams live Docker container stats.
 *
 * Opens a `stats({ stream: true })` connection per running container (capped at
 * `maxStatStreams`, see `resolveMaxStatStreams`) and forwards NDJSON frames as SSE
 * `data` events. A background poll loop refreshes the container list every
 * `refreshIntervalMs` (checked every `pollIntervalMs`), opening streams for new
 * containers and destroying stale ones.
 *
 * SSE event types emitted:
 * - `data` (default): `{ containerId, containerName, image, cpuPercent, memoryUsage, ... }`, pre-computed metrics
 * - `containers`: `{ ids: string[] }`, emitted after each container list refresh
 * - `container-error`: `{ containerId, error }`, per-container stream or open failure
 * - `container-error` with `type: "refresh_failed"`: `{ error, type }`, container list refresh failure
 * - `stream-cap-exceeded`: `{ error, maxStatStreams, totalContainers, skippedContainers }`,
 *   emitted when the running container count exceeds the stat stream cap; only the first
 *   `maxStatStreams` containers are streamed
 * - `error`: `{ error }`, fatal stream-level failure (e.g. initial listContainers fails)
 *
 * Clients MUST handle the `error` and `container-error` SSE events since the HTTP
 * status is always 200 (the Response is returned before async start() runs).
 *
 * The stream closes when the client disconnects (abort signal) or after
 * `maxConsecutiveFailures` consecutive refresh failures (circuit breaker).
 *
 * @param docker - Dockerode client used to interact with the Docker daemon
 * @param request - The HTTP request; its abort signal triggers cleanup
 * @param options - Tuning knobs for poll/refresh intervals and failure threshold
 */
export function handleStatsStream(
  docker: Dockerode,
  request: Request,
  options: StatsStreamOptions = {}
): Response {
  const refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const maxStatStreams = options.maxStatStreams ?? resolveMaxStatStreams();

  const stream = new ReadableStream({
    async start(controller) {
      const ctx: StreamContext = {
        closed: false,
        encoder: new TextEncoder(),
        containerStreams: new Map(),
        controller,
      };

      request.signal.addEventListener('abort', () => {
        ctx.closed = true;
        destroyAllStreams(ctx.containerStreams);
        tryCloseController(controller);
      });

      try {
        await runStatsLoop(ctx, docker, pollIntervalMs, refreshIntervalMs, maxConsecutiveFailures, maxStatStreams);
      } catch (error) {
        console.error('Failed to start stats stream:', error);
        const msg = error instanceof Error ? error.message : String(error);
        sendSSE(ctx, JSON.stringify({ error: msg }), 'error');
        tryCloseController(controller);
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
