import type { ZfsCapabilities } from '../lib/zfs-capabilities';

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

  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        const proc = Bun.spawn(['zpool', 'iostat', '-v', '1'], {
          stdout: 'pipe',
          stderr: 'pipe',
        });

        let closed = false;

        request.signal.addEventListener('abort', () => {
          closed = true;
          proc.kill();
          try {
            controller.close();
          } catch {
            // controller already closed
          }
        });

        try {
          const reader = proc.stdout.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (!closed) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (closed) break;
              if (!line.trim()) continue;

              try {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ line, timestamp: Date.now() })}\n\n`),
                );
              } catch {
                closed = true;
                break;
              }
            }
          }
        } catch (err) {
          if (!closed) {
            console.error('ZFS stats stream error:', err);
          }
        } finally {
          proc.kill();
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              // controller already closed
            }
          }
        }
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    },
  );
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
