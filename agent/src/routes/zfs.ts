import { createSseStream, type SseEmitter } from '../lib/sse-stream';
import type { ZfsCapabilities } from '../lib/zfs-capabilities';
import { routeErrorBody } from '../lib/error-body';
import type { AgentRouteErrorBody } from '../types';
import type { ZfsStatsFrame } from '../types/protocol';
import {
  IostatSampleReader,
  parseZpoolStatus,
  withSpares,
  ZPOOL_IOSTAT_ARGS,
  ZPOOL_STATUS_ARGS,
  type ZpoolStatusSummary,
} from '../lib/zfs-iostat';

async function readLines(
  stream: ReadableStream<Uint8Array>,
  isStopped: () => boolean,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (!isStopped()) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (isStopped()) return;
      if (line.trim()) onLine(line);
    }
  }
}

interface IostatRun {
  proc: ReturnType<typeof Bun.spawn>;
  startedAt: number;
  replaced: boolean;
}

export interface ZfsStatsStreamOptions {
  statusIntervalMs?: number;
  statusTimeoutMs?: number;
  /** How long a fresh iostat gets to report a pool before a missing pool restarts it again. */
  restartGraceMs?: number;
  now?: () => number;
}

const DEFAULT_STATUS_INTERVAL_MS = 5000;
const DEFAULT_STATUS_TIMEOUT_MS = 10_000;
const DEFAULT_RESTART_GRACE_MS = 10_000;
/** zpool iostat prints this every interval while no pool is imported. The status poll reports that state instead. */
const IOSTAT_EXPECTED_STDERR: ReadonlySet<string> = new Set(['no pools available']);

/**
 * Drain a subprocess's stderr into the agent log. Reading it is not optional:
 * an unread pipe fills its OS buffer and blocks the process's stdout.
 */
async function drainErrors(
  label: string,
  stderr: ReadableStream<Uint8Array>,
  isStopped: () => boolean,
  expected: ReadonlySet<string> = new Set(),
): Promise<void> {
  try {
    await readLines(stderr, isStopped, (line) => {
      if (!expected.has(line.trim())) console.error(`${label}:`, line);
    });
  } catch (err) {
    if (!isStopped()) {
      console.error('ZFS stats stderr read error:', err);
    }
  }
}

async function readZpoolStatus(
  timeoutMs: number,
  isStopped: () => boolean,
  track: (proc: ReturnType<typeof Bun.spawn> | null) => void,
): Promise<ZpoolStatusSummary | null> {
  const proc = Bun.spawn(ZPOOL_STATUS_ARGS, { stdout: 'pipe', stderr: 'pipe' });
  track(proc);
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    void drainErrors('zpool status', proc.stderr as ReadableStream<Uint8Array>, isStopped);
    const [exitCode, text] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    ]);
    if (exitCode !== 0) {
      if (!isStopped()) console.error(`zpool status exited with ${exitCode}`);
      return null;
    }
    const summary = parseZpoolStatus(text);
    if (!summary && !isStopped()) console.error('zpool status printed output this agent cannot read');
    return summary;
  } finally {
    clearTimeout(timer);
    track(null);
  }
}

function missingPoolsKey(reportable: Set<string>, reported: Set<string>): string | null {
  const missing = [...reportable].filter((name) => !reported.has(name)).sort((a, b) => a.localeCompare(b));
  return missing.length > 0 ? missing.join('\n') : null;
}

function startZfsStatsSession(emit: SseEmitter, options: ZfsStatsStreamOptions): () => void {
  const now = options.now ?? Date.now;
  const statusTimeoutMs = options.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
  const restartGraceMs = options.restartGraceMs ?? DEFAULT_RESTART_GRACE_MS;

  let stopped = false;
  let run: IostatRun | null = null;
  let statusProc: ReturnType<typeof Bun.spawn> | null = null;
  let statusInFlight = false;
  let sparesByPool = new Map<string, string[]>();
  let reportedPools = new Set<string>();
  let lastRestartKey: string | null = null;

  const startIostat = (): void => {
    const proc = Bun.spawn(ZPOOL_IOSTAT_ARGS, { stdout: 'pipe', stderr: 'pipe' });
    const current: IostatRun = { proc, startedAt: now(), replaced: false };
    run = current;
    reportedPools = new Set();
    const isDone = () => stopped || current.replaced;
    const reader = new IostatSampleReader((pools, time) => {
      if (isDone()) return;
      reportedPools = new Set(pools.map((pool) => pool.name));
      emit.data({ v: 1, time, pools: withSpares(pools, sparesByPool) } satisfies ZfsStatsFrame);
    }, now);

    void (async () => {
      try {
        await readLines(proc.stdout as ReadableStream<Uint8Array>, isDone, (line) => reader.push(line));
      } catch (err) {
        if (!isDone()) console.error('ZFS stats stream error:', err);
      } finally {
        if (!isDone()) emit.close();
      }
    })();
    void drainErrors('zpool iostat', proc.stderr as ReadableStream<Uint8Array>, isDone, IOSTAT_EXPECTED_STDERR);
  };

  const restartIfPoolMissing = (reportable: Set<string>): void => {
    const key = missingPoolsKey(reportable, reportedPools);
    if (key === null) {
      lastRestartKey = null;
      return;
    }
    if (!run || key === lastRestartKey || now() - run.startedAt < restartGraceMs) return;
    lastRestartKey = key;
    console.info(`Restarting zpool iostat to pick up pool(s): ${key.split('\n').join(', ')}`);
    run.replaced = true;
    run.proc.kill();
    try {
      startIostat();
    } catch (err) {
      console.error('Could not restart zpool iostat, closing the ZFS stats stream:', err);
      emit.close();
    }
  };

  const pollStatus = async (): Promise<void> => {
    if (statusInFlight || stopped) return;
    statusInFlight = true;
    try {
      const summary = await readZpoolStatus(statusTimeoutMs, () => stopped, (proc) => {
        statusProc = proc;
      });
      if (stopped || !summary) return;
      sparesByPool = summary.sparesByPool;
      if (summary.reportablePools.size === 0) {
        // iostat prints nothing at all without a pool, so this frame is what moves the host's newest sample on.
        reportedPools = new Set();
        emit.data({ v: 1, time: now(), pools: [] } satisfies ZfsStatsFrame);
      }
      restartIfPoolMissing(summary.reportablePools);
    } catch (err) {
      if (!stopped) console.error('zpool status failed:', err);
    } finally {
      statusInFlight = false;
    }
  };

  // Spawned before the timer is armed: a spawn that throws here must not leave a status poll running.
  startIostat();
  const statusTimer = setInterval(() => void pollStatus(), options.statusIntervalMs ?? DEFAULT_STATUS_INTERVAL_MS);
  void pollStatus();
  return () => {
    stopped = true;
    clearInterval(statusTimer);
    run?.proc.kill();
    statusProc?.kill();
  };
}

/**
 * GET /zfs/stats/stream: SSE endpoint that sends one `ZfsStatsFrame` per `zpool iostat` sample.
 * The subprocesses are killed when the client disconnects.
 */
export function handleZfsStatsStream(
  request: Request,
  capabilities: ZfsCapabilities,
  options: ZfsStatsStreamOptions = {},
): Response {
  if (!capabilities.available) {
    return Response.json(
      routeErrorBody('zfs_unavailable'),
      { status: 503 },
    );
  }

  return createSseStream(request, {
    onStart: (emit) => startZfsStatsSession(emit, options),
  });
}

/**
 * GET /zfs/pools: Returns parsed pool data from `zpool list -Hp`.
 *
 * Response: `{ pools: Array<{ name, size, allocated, free, fragmentation, capacity, dedup, health }> }`
 */
export async function handleZfsPools(
  capabilities: ZfsCapabilities,
): Promise<Response> {
  if (!capabilities.available) {
    return Response.json(
      routeErrorBody('zfs_unavailable'),
      { status: 503 },
    );
  }

  try {
    const proc = Bun.spawn(['zpool', 'list', '-Hp'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    const output = await new Response(proc.stdout).text();

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return Response.json(
        {
          ...routeErrorBody('zfs_pool_list_failed'),
          detail: stderr.trim(),
        } satisfies AgentRouteErrorBody,
        { status: 500 },
      );
    }

    // Columns: name, size, alloc, free, ckpoint, expandsz, frag, cap, dedup, health, altroot
    const pools = output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const cols = line.split('\t');
        return {
          name: cols[0],
          size: Number(cols[1]),
          allocated: Number(cols[2]),
          free: Number(cols[3]),
          fragmentation: cols[6] === '-' ? null : Number(cols[6]),
          capacity: Number(cols[7]),
          dedup: Number(cols[8]),
          health: cols[9],
        };
      });

    return Response.json({ pools });
  } catch (err) {
    console.error('Failed to list ZFS pools:', err);
    return Response.json(
      {
        ...routeErrorBody('zfs_pool_list_failed'),
        detail: err instanceof Error ? err.message : String(err),
      } satisfies AgentRouteErrorBody,
      { status: 500 },
    );
  }
}
