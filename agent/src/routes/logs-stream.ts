import type { Readable } from 'node:stream';
import type Dockerode from 'dockerode';
import { createSseStream, type SseEmitter } from '../lib/sse-stream';
import { splitTimestamp, parseMuxedChunk, parseTtyChunk, type LogLine } from '../lib/log-parse';
import { isContainerGone } from './stats';

const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 10;

const MAX_SINCE_LOOKBACK_SECONDS = 300;
const ATTACH_TAIL_LINES = 1_000;

const MAX_LINE_BYTES = 8_192;
const MAX_REMAINDER_BYTES = 1_048_576;

const CONTAINER_LINES_PER_SEC = 200;
const CONTAINER_BURST_LINES = 400;
const STREAM_LINES_PER_SEC = 2_000;
const STREAM_BURST_LINES = 4_000;
const THROTTLE_NOTICE_INTERVAL_MS = 5_000;

const MAX_CONTAINER_OPEN_FAILURES = 5;

export interface FleetLogStreamOptions {
  refreshIntervalMs?: number;
  pollIntervalMs?: number;
  /** Close the stream after this many consecutive refresh failures (default: 10). */
  maxConsecutiveFailures?: number;
}

export interface FleetLogLine {
  containerId: string;
  containerName: string;
  at: string | null;
  stream: 'stdout' | 'stderr';
  text: string;
  truncated?: true;
}

export interface FleetLogContainer {
  id: string;
  name: string;
}

export interface FleetLogContainersEvent {
  containers: FleetLogContainer[];
}

export interface FleetLogReadyEvent {
  sinceSeconds: number;
  clamped: boolean;
}

export type FleetLogErrorType =
  | 'open_failed'
  | 'stream_error'
  | 'attach_abandoned'
  | 'parse_overflow'
  | 'refresh_failed';

export interface FleetLogErrorEvent {
  containerId?: string;
  error: string;
  type: FleetLogErrorType;
}

export interface FleetLogThrottleEvent {
  containerId: string | null;
  dropped: number;
  windowMs: number;
}

export interface Bucket {
  tokens: number;
  lastRefillMs: number;
  dropped: number;
  lastNoticeMs: number;
}

interface ContainerState {
  name: string;
  stream: Readable;
  isTty: boolean | null;
  remainder: Buffer;
  lastAt: string | null;
  bucket: Bucket;
  lastParseOverflowNoticeMs: number;
}

/** Shared mutable state for a single SSE fleet-log session. */
interface FleetLogContext {
  /** Flipped by the stream's cleanup, so the poll loop and any in-flight attach stop touching state. */
  stopped: boolean;
  readonly emit: SseEmitter;
  readonly containers: Map<string, ContainerState>;
  /** Survives a container's stream `end`/`error` so reattach resumes instead of replaying or losing the gap. */
  readonly lastAtByContainer: Map<string, string>;
  readonly openFailures: Map<string, number>;
  /** Ids with a `logs()` call in flight, so a reconcile racing the resolution can't attach the same container twice. */
  readonly pendingAttach: Set<string>;
  readonly globalBucket: Bucket;
}

export function makeBucket(burst: number): Bucket {
  const now = Date.now();
  return { tokens: burst, lastRefillMs: now, dropped: 0, lastNoticeMs: now };
}

export function tryConsume(bucket: Bucket, ratePerSec: number, burst: number, now: number): boolean {
  const elapsedSec = (now - bucket.lastRefillMs) / 1000;
  bucket.tokens = Math.min(burst, bucket.tokens + elapsedSec * ratePerSec);
  bucket.lastRefillMs = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function noteDrop(ctx: FleetLogContext, containerId: string | null, bucket: Bucket, now: number): void {
  bucket.dropped += 1;
  if (now - bucket.lastNoticeMs < THROTTLE_NOTICE_INTERVAL_MS) return;

  const dropped = bucket.dropped;
  bucket.dropped = 0;
  bucket.lastNoticeMs = now;
  console.info(`Dropped ${dropped} fleet log line(s) for ${containerId ?? 'global'} over the last ${THROTTLE_NOTICE_INTERVAL_MS}ms`);
  ctx.emit.event('throttled', { containerId, dropped, windowMs: THROTTLE_NOTICE_INTERVAL_MS } satisfies FleetLogThrottleEvent);
}

/** Spends one token from the container bucket, then one from the global bucket; a rejection by either drops the line. */
function admitLine(ctx: FleetLogContext, containerId: string, state: ContainerState, now: number): boolean {
  if (!tryConsume(state.bucket, CONTAINER_LINES_PER_SEC, CONTAINER_BURST_LINES, now)) {
    noteDrop(ctx, containerId, state.bucket, now);
    return false;
  }
  if (!tryConsume(ctx.globalBucket, STREAM_LINES_PER_SEC, STREAM_BURST_LINES, now)) {
    noteDrop(ctx, null, ctx.globalBucket, now);
    return false;
  }
  return true;
}

function truncateLine(text: string): { text: string; truncated?: true } {
  if (Buffer.byteLength(text) <= MAX_LINE_BYTES) return { text };
  return { text: Buffer.from(text).subarray(0, MAX_LINE_BYTES).toString(), truncated: true };
}

// listContainers doesn't report Tty and an inspect-per-container costs 100 extra
// daemon round trips at attach: a muxed frame header starts with a stream-type
// byte <= 2 followed by three zero length-prefix bytes, while a TTY line (with
// timestamps: true) always starts with the ASCII digit '2' (0x32) of the year.
function sniffTty(chunk: Buffer): boolean {
  return !(chunk[0] <= 2 && chunk[1] === 0 && chunk[2] === 0 && chunk[3] === 0);
}

function toFleetLogContainer(info: Dockerode.ContainerInfo): FleetLogContainer {
  return { id: info.Id, name: info.Names[0]?.replace(/^\//, '') ?? info.Id };
}

function processLine(ctx: FleetLogContext, id: string, state: ContainerState, line: LogLine): void {
  const { at, text } = splitTimestamp(line.text);
  const now = Date.now();
  if (!admitLine(ctx, id, state, now)) return;

  if (at) {
    state.lastAt = at;
    ctx.lastAtByContainer.set(id, at);
  }

  const { text: finalText, truncated } = truncateLine(text);
  const frame: FleetLogLine = {
    containerId: id,
    containerName: state.name,
    at,
    stream: line.stream,
    text: finalText,
    ...(truncated ? { truncated: true as const } : {}),
  };
  ctx.emit.data(frame);
}

/** Open a fleet log stream for a single container and wire up SSE forwarding. */
function openLogStream(
  ctx: FleetLogContext,
  docker: Dockerode,
  container: FleetLogContainer,
  sinceSeconds: number,
): void {
  const { id, name } = container;
  ctx.pendingAttach.add(id);

  docker.getContainer(id).logs({
    follow: true,
    stdout: true,
    stderr: true,
    timestamps: true,
    since: sinceSeconds,
    tail: ATTACH_TAIL_LINES,
  }).then((logsResult) => {
    // @types/dockerode 4.0.1 types logs() stream result as any; cast required to use Readable API
    const readable = logsResult as unknown as Readable;
    ctx.pendingAttach.delete(id);
    if (ctx.stopped) {
      if (typeof readable.destroy === 'function') readable.destroy();
      return;
    }

    const state: ContainerState = {
      name,
      stream: readable,
      isTty: null,
      remainder: Buffer.alloc(0),
      lastAt: null,
      bucket: makeBucket(CONTAINER_BURST_LINES),
      lastParseOverflowNoticeMs: Date.now(),
    };
    ctx.containers.set(id, state);
    ctx.openFailures.delete(id);

    readable.on('data', (chunk: Buffer) => {
      if (ctx.stopped) return;
      if (state.isTty === null) state.isTty = sniffTty(chunk);

      let lines: LogLine[];
      if (state.isTty) {
        lines = parseTtyChunk(chunk);
      } else {
        const input = state.remainder.length > 0 ? Buffer.concat([state.remainder, chunk]) : chunk;
        const result = parseMuxedChunk(input);
        lines = result.lines;
        state.remainder = result.remainder;
        if (state.remainder.length > MAX_REMAINDER_BYTES) {
          state.remainder = Buffer.alloc(0);
          const now = Date.now();
          if (now - state.lastParseOverflowNoticeMs >= THROTTLE_NOTICE_INTERVAL_MS) {
            state.lastParseOverflowNoticeMs = now;
            ctx.emit.event('container-error', {
              containerId: id,
              error: 'log parse remainder exceeded MAX_REMAINDER_BYTES',
              type: 'parse_overflow',
            } satisfies FleetLogErrorEvent);
          }
        }
      }

      for (const line of lines) {
        processLine(ctx, id, state, line);
      }
    });

    readable.on('error', (error: Error) => {
      if (ctx.containers.get(id) !== state) return;
      if (isContainerGone(error)) {
        if (typeof state.stream.destroy === 'function') state.stream.destroy();
        ctx.containers.delete(id);
        return;
      }
      console.error(`Fleet log stream error for container ${id}:`, error.message);
      ctx.emit.event('container-error', { containerId: id, error: error.message, type: 'stream_error' } satisfies FleetLogErrorEvent);
      if (typeof state.stream.destroy === 'function') state.stream.destroy();
      ctx.containers.delete(id);
    });

    readable.on('end', () => {
      if (ctx.containers.get(id) !== state) return;
      ctx.containers.delete(id);
    });
  }).catch((error: Error) => {
    ctx.pendingAttach.delete(id);
    if (ctx.stopped) return;
    if (isContainerGone(error)) return;
    console.error(`Failed to open fleet log stream for container ${id}:`, error.message);
    ctx.emit.event('container-error', { containerId: id, error: error.message, type: 'open_failed' } satisfies FleetLogErrorEvent);

    const failures = (ctx.openFailures.get(id) ?? 0) + 1;
    ctx.openFailures.set(id, failures);
    if (failures >= MAX_CONTAINER_OPEN_FAILURES) {
      ctx.emit.event('container-error', {
        containerId: id,
        error: `Container exceeded ${MAX_CONTAINER_OPEN_FAILURES} consecutive open failures, no longer retried`,
        type: 'attach_abandoned',
      } satisfies FleetLogErrorEvent);
    }
  });
}

/**
 * Diff current containers against what is actually attached (`ctx.containers.keys()`,
 * not a snapshot of the previous list): an id whose open failed, whose stream
 * errored, or whose stream ended is absent from the attached set, so this retries
 * it for free. Diffing against a previous-list snapshot would mark it "unchanged"
 * and never reattach it, silently losing a restarted container's logs forever.
 */
function reconcileFleetContainers(
  ctx: FleetLogContext,
  docker: Dockerode,
  current: FleetLogContainer[],
  previousRefreshAtSeconds: number,
): void {
  const currentIds = new Set(current.map((c) => c.id));
  const attachedIds = new Set(ctx.containers.keys());

  for (const id of attachedIds) {
    if (currentIds.has(id)) continue;
    const state = ctx.containers.get(id);
    if (state && typeof state.stream.destroy === 'function') state.stream.destroy();
    ctx.containers.delete(id);
  }

  // Pruned against currentIds directly, not attachedIds: an id whose stream already
  // ended or errored is absent from attachedIds too, so scoping this to departed
  // *attached* ids would leave its bookkeeping here forever once it stops reappearing.
  for (const id of ctx.lastAtByContainer.keys()) {
    if (!currentIds.has(id)) ctx.lastAtByContainer.delete(id);
  }
  for (const id of ctx.openFailures.keys()) {
    if (!currentIds.has(id)) ctx.openFailures.delete(id);
  }

  for (const container of current) {
    if (ctx.containers.has(container.id)) continue;
    if (ctx.pendingAttach.has(container.id)) continue;
    if ((ctx.openFailures.get(container.id) ?? 0) >= MAX_CONTAINER_OPEN_FAILURES) continue;

    const lastAt = ctx.lastAtByContainer.get(container.id);
    const since = lastAt ? (new Date(lastAt).getTime() + 1) / 1000 : previousRefreshAtSeconds;
    openLogStream(ctx, docker, container, since);
  }

  ctx.emit.event('containers', { containers: current } satisfies FleetLogContainersEvent);
}

async function tryRefreshFleetContainers(
  ctx: FleetLogContext,
  docker: Dockerode,
  previousRefreshAtSeconds: number,
  failureCount: number,
  maxFailures: number,
): Promise<{ containers: FleetLogContainer[]; shouldBreak: boolean } | null> {
  try {
    const list = await docker.listContainers({ all: false });
    if (ctx.stopped) return { containers: [], shouldBreak: true };
    const current = list.map(toFleetLogContainer);
    reconcileFleetContainers(ctx, docker, current, previousRefreshAtSeconds);
    return { containers: current, shouldBreak: false };
  } catch (error) {
    const count = failureCount + 1;
    console.error(`Failed to refresh container list (${count}/${maxFailures}):`, error);
    const msg = error instanceof Error ? error.message : String(error);
    ctx.emit.event('container-error', { error: msg, type: 'refresh_failed' } satisfies FleetLogErrorEvent);

    if (count >= maxFailures) {
      console.error('Max consecutive refresh failures reached, closing fleet log stream');
      ctx.emit.event('error', { error: 'Docker daemon unreachable, stream closed' });
    }
    return null;
  }
}

/** Destroy every attached stream and clear all session bookkeeping. */
function teardownAll(ctx: FleetLogContext): void {
  for (const state of ctx.containers.values()) {
    if (typeof state.stream.destroy === 'function') state.stream.destroy();
  }
  ctx.containers.clear();
  ctx.lastAtByContainer.clear();
  ctx.openFailures.clear();
  ctx.pendingAttach.clear();
}

async function runFleetLogLoop(
  ctx: FleetLogContext,
  docker: Dockerode,
  pollIntervalMs: number,
  refreshIntervalMs: number,
  maxConsecutiveFailures: number,
  sinceSeconds: number,
  clamped: boolean,
): Promise<void> {
  const list = await docker.listContainers({ all: false });
  if (ctx.stopped) return;

  const initial = list.map(toFleetLogContainer);
  for (const container of initial) {
    openLogStream(ctx, docker, container, sinceSeconds);
  }

  ctx.emit.event('containers', { containers: initial } satisfies FleetLogContainersEvent);
  ctx.emit.event('ready', { sinceSeconds, clamped } satisfies FleetLogReadyEvent);

  let lastRefreshMs = Date.now();
  let consecutiveFailures = 0;

  while (!ctx.stopped) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    if (ctx.stopped) break;

    const now = Date.now();
    if (now - lastRefreshMs < refreshIntervalMs) continue;
    const previousRefreshAtSeconds = lastRefreshMs / 1000;
    lastRefreshMs = now;

    const result = await tryRefreshFleetContainers(ctx, docker, previousRefreshAtSeconds, consecutiveFailures, maxConsecutiveFailures);
    if (!result) {
      consecutiveFailures++;
      if (consecutiveFailures >= maxConsecutiveFailures) break;
      continue;
    }
    if (result.shouldBreak) break;
    consecutiveFailures = 0;
  }

  teardownAll(ctx);
  ctx.emit.close();
}

function resolveSinceSeconds(request: Request): { sinceSeconds: number; clamped: boolean } {
  const url = new URL(request.url);
  const raw = url.searchParams.get('since');
  const nowSeconds = Date.now() / 1000;

  if (raw === null) return { sinceSeconds: nowSeconds, clamped: false };

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > nowSeconds) {
    return { sinceSeconds: nowSeconds, clamped: false };
  }

  const minSeconds = nowSeconds - MAX_SINCE_LOOKBACK_SECONDS;
  if (parsed < minSeconds) return { sinceSeconds: minSeconds, clamped: true };
  return { sinceSeconds: parsed, clamped: false };
}

/**
 * Create an SSE Response that streams every running container's logs on a host
 * over a single connection, fleet-wide (no per-consumer container filter).
 *
 * Opens a `logs({ follow: true })` stream per container and forwards parsed
 * lines as SSE `data` events, with the Docker timestamp prefix stripped into
 * `at`. A background poll loop refreshes the container list every
 * `refreshIntervalMs` (checked every `pollIntervalMs`), attaching new
 * containers and detaching gone ones; a container whose stream ends or errors
 * stays in the list and is reattached at the next reconcile.
 *
 * SSE event types emitted:
 * - `data` (default): `FleetLogLine`
 * - `containers`: `FleetLogContainersEvent`, after the initial attach and after every reconcile
 * - `ready`: `FleetLogReadyEvent`, once, right after the first `containers` frame
 * - `container-error`: `FleetLogErrorEvent`, per-container or refresh failure
 * - `throttled`: `FleetLogThrottleEvent`, at most once per `THROTTLE_NOTICE_INTERVAL_MS` per bucket
 * - `error`: `{ error }`, fatal stream-level failure
 *
 * Clients MUST handle the `error` and `container-error` SSE events since the
 * HTTP status is always 200 (the Response is returned before async start() runs).
 *
 * @param docker - Dockerode client used to interact with the Docker daemon
 * @param request - The HTTP request; its `since` query param and abort signal both come from here
 * @param options - Tuning knobs for poll/refresh intervals and failure threshold
 */
export function handleFleetLogStream(
  docker: Dockerode,
  request: Request,
  options: FleetLogStreamOptions = {}
): Response {
  const refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const { sinceSeconds, clamped } = resolveSinceSeconds(request);

  return createSseStream(request, {
    onStart: (emit) => {
      const ctx: FleetLogContext = {
        stopped: false,
        emit,
        containers: new Map(),
        lastAtByContainer: new Map(),
        openFailures: new Map(),
        pendingAttach: new Set(),
        globalBucket: makeBucket(STREAM_BURST_LINES),
      };

      // Not awaited: the cleanup below has to be registered before the poll
      // loop blocks, or a teardown mid-loop would never stop it.
      void runFleetLogLoop(ctx, docker, pollIntervalMs, refreshIntervalMs, maxConsecutiveFailures, sinceSeconds, clamped).catch((error) => {
        console.error('Failed to start fleet log stream:', error);
        const msg = error instanceof Error ? error.message : String(error);
        emit.event('error', { error: msg });
        emit.close();
      });

      return () => {
        ctx.stopped = true;
        teardownAll(ctx);
      };
    },
  });
}
