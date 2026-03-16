import type { Readable } from 'node:stream';
import type Dockerode from 'dockerode';

const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 10;

export interface StatsStreamOptions {
  refreshIntervalMs?: number;
  pollIntervalMs?: number;
  /** Close the stream after this many consecutive refresh failures (default: 10). */
  maxConsecutiveFailures?: number;
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
): void {
  const id = containerInfo.Id;
  const name = containerInfo.Names[0]?.replace(/^\//, '') ?? id;
  const image = containerInfo.Image;
  const container = docker.getContainer(id);

  container.stats({ stream: true }).then((statsStream) => {
    const readable = statsStream as unknown as Readable;
    ctx.containerStreams.set(id, readable);

    let buffer = '';
    readable.on('data', (chunk: Buffer) => {
      if (ctx.closed) return;
      buffer = parseStatsChunks(buffer, chunk, (stats) => {
        sendSSE(ctx, JSON.stringify({ containerId: id, containerName: name, image, stats }));
      }, () => {
        console.error(`Malformed stats JSON from container ${id}, skipping frame`);
      });
    });

    readable.on('error', (error: Error) => {
      console.error(`Stats stream error for container ${id}:`, error.message);
      sendErrorSSE(ctx, { containerId: id, error: error.message });
      ctx.containerStreams.delete(id);
    });

    readable.on('end', () => {
      ctx.containerStreams.delete(id);
    });
  }).catch((error: Error) => {
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
): void {
  const currentIds = new Set(current.map(c => c.Id));
  const previousIds = new Set(previous.map(c => c.Id));

  for (const prevId of previousIds) {
    if (!currentIds.has(prevId)) {
      const stale = ctx.containerStreams.get(prevId);
      if (stale && typeof stale.destroy === 'function') stale.destroy();
      ctx.containerStreams.delete(prevId);
    }
  }

  for (const c of current) {
    if (!previousIds.has(c.Id)) openContainerStream(ctx, docker, c);
  }

  sendSSE(ctx, JSON.stringify({ ids: [...currentIds] }), 'containers');
}

/**
 * Create an SSE Response that streams live Docker container stats.
 *
 * Opens a `stats({ stream: true })` connection per running container and forwards
 * NDJSON frames as SSE `data` events. A background poll loop refreshes the container
 * list every `refreshIntervalMs` (checked every `pollIntervalMs`), opening streams for
 * new containers and destroying stale ones.
 *
 * SSE event types emitted:
 * - `data` (default): `{ containerId, containerName, image, stats }` — raw Docker stats frame
 * - `containers`: `{ ids: string[] }` — emitted after each container list refresh
 * - `container-error`: `{ containerId, error }` — per-container stream or open failure
 * - `container-error` with `type: "refresh_failed"`: `{ error, type }` — container list refresh failure
 * - `error`: `{ error }` — fatal stream-level failure (e.g. initial listContainers fails)
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
        try {
          controller.close();
        } catch {
          // controller already closed
        }
      });

      try {
        let containers = await docker.listContainers({ all: false });
        let lastRefresh = Date.now();
        let consecutiveFailures = 0;

        for (const c of containers) {
          openContainerStream(ctx, docker, c);
        }

        while (!ctx.closed) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          if (ctx.closed) break;

          const now = Date.now();
          if (now - lastRefresh < refreshIntervalMs) continue;
          lastRefresh = now;

          try {
            const current = await docker.listContainers({ all: false });
            reconcileContainers(ctx, docker, containers, current);
            containers = current;
            consecutiveFailures = 0;
          } catch (error) {
            consecutiveFailures++;
            console.error(`Failed to refresh container list (${consecutiveFailures}/${maxConsecutiveFailures}):`, error);
            const msg = error instanceof Error ? error.message : String(error);
            sendErrorSSE(ctx, { error: msg, type: 'refresh_failed' });

            if (consecutiveFailures >= maxConsecutiveFailures) {
              console.error('Max consecutive refresh failures reached, closing stats stream');
              sendSSE(ctx, JSON.stringify({ error: 'Docker daemon unreachable, stream closed' }), 'error');
              break;
            }
          }
        }
      } catch (error) {
        console.error('Failed to start stats stream:', error);
        const msg = error instanceof Error ? error.message : String(error);
        sendSSE(ctx, JSON.stringify({ error: msg }), 'error');
        try {
          controller.close();
        } catch {
          // controller already closed
        }
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
