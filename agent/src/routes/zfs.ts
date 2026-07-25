import { createSseStream, type SseEmitter } from '../lib/sse-stream';
import type { ZfsCapabilities } from '../lib/zfs-capabilities';

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

/** Forward each non-empty `zpool iostat` line as a `{ line, timestamp }` frame until the stream stops. */
async function pumpZpoolOutput(
  emit: SseEmitter,
  stdout: ReadableStream<Uint8Array>,
  isStopped: () => boolean,
): Promise<void> {
  try {
    await readLines(stdout, isStopped, (line) => {
      emit.data({ line, timestamp: Date.now() });
    });
  } catch (err) {
    if (!isStopped()) {
      console.error('ZFS stats stream error:', err);
    }
  } finally {
    emit.close();
  }
}

/**
 * Drain the subprocess's stderr into the agent log. Reading it is not optional:
 * this process lives for the whole SSE session, so an unread pipe fills its OS
 * buffer and blocks zpool's stdout, stalling the stream it is meant to feed.
 */
async function drainZpoolErrors(
  stderr: ReadableStream<Uint8Array>,
  isStopped: () => boolean,
): Promise<void> {
  try {
    await readLines(stderr, isStopped, (line) => {
      console.error('zpool iostat:', line);
    });
  } catch (err) {
    if (!isStopped()) {
      console.error('ZFS stats stderr read error:', err);
    }
  }
}

/**
 * GET /zfs/stats/stream: SSE endpoint that streams `zpool iostat -v 1` output.
 *
 * Each non-empty line from the subprocess is emitted as an SSE event with
 * `{ line, timestamp }`. The subprocess is killed when the client disconnects.
 */
export function handleZfsStatsStream(
  request: Request,
  capabilities: ZfsCapabilities,
): Response {
  if (!capabilities.available) {
    return Response.json(
      { error: 'ZFS is not available on this host' },
      { status: 503 },
    );
  }

  return createSseStream(request, {
    onStart: (emit) => {
      const proc = Bun.spawn(['zpool', 'iostat', '-v', '1'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      let stopped = false;
      // Not awaited: the cleanup below has to be registered before the read
      // loops block, or a teardown mid-loop would never kill the subprocess.
      void pumpZpoolOutput(emit, proc.stdout, () => stopped);
      void drainZpoolErrors(proc.stderr, () => stopped);

      return () => {
        stopped = true;
        proc.kill();
      };
    },
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
      { error: 'ZFS is not available on this host' },
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
        { error: 'Failed to list ZFS pools', detail: stderr.trim() },
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
      { error: 'Failed to list ZFS pools', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
