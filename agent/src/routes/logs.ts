import type { Readable } from 'node:stream';
import type Dockerode from 'dockerode';

/**
 * Stream a Docker container's logs to the client over a Server-Sent Events (SSE) connection.
 *
 * Streams recent and live stdout/stderr output from the specified container as SSE `data` events containing JSON-encoded log objects; emits SSE `error` events on failures and closes the stream when the request is aborted or the log stream ends.
 *
 * @param containerId - The ID or name of the container whose logs will be streamed
 * @returns A Response exposing an SSE stream that emits JSON-encoded log lines and error events
 */
export function handleLogStream(
  docker: Dockerode,
  containerId: string,
  request: Request
): Response {
  let closed = false;
  let logStream: Readable | null = null;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      request.signal.addEventListener('abort', () => {
        closed = true;
        if (typeof logStream?.destroy === 'function') {
          logStream.destroy();
        }
        try {
          controller.close();
        } catch {
          // controller may already be closed
        }
      });

      try {
        const container = docker.getContainer(containerId);
        const info = await container.inspect();
        const isTty = info.Config?.Tty ?? false;

        logStream = (await container.logs({
          follow: true,
          stdout: true,
          stderr: true,
          tail: 200,
          timestamps: true,
        })) as unknown as Readable;

        let muxedRemainder: Buffer = Buffer.alloc(0);

        logStream.on('data', (chunk: Buffer) => {
          if (closed) return;

          let lines: LogLine[];
          if (isTty) {
            lines = parseTtyChunk(chunk);
          } else {
            const input = muxedRemainder.length > 0
              ? Buffer.concat([muxedRemainder, chunk])
              : chunk;
            const result = parseMuxedChunk(input);
            lines = result.lines;
            muxedRemainder = result.remainder;
          }

          try {
            for (const line of lines) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(line)}\n\n`)
              );
            }
          } catch {
            // enqueue-after-close race — client already disconnected
          }
        });

        logStream.on('end', () => {
          if (!closed) {
            closed = true;
            controller.close();
          }
        });

        logStream.on('error', (error: Error) => {
          console.error(`Log stream error for container ${containerId}:`, error);
          if (!closed) {
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`
              )
            );
            closed = true;
            controller.close();
          }
        });
      } catch (error) {
        console.error(`Failed to start log stream for container ${containerId}:`, error);
        const msg = error instanceof Error ? error.message : String(error);
        try {
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`
            )
          );
          closed = true;
          controller.close();
        } catch {
          // controller may already be closed
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

interface LogLine {
  stream: 'stdout' | 'stderr';
  text: string;
}

/**
 * Parse a TTY-mode Docker log chunk into individual log lines.
 *
 * Splits the chunk by newline, discards empty lines, and marks every line as `stdout`.
 *
 * @param chunk - Raw buffer read from a container's TTY log stream
 * @returns An array of `LogLine` objects where `stream` is `'stdout'` and `text` is each non-empty line from the chunk
 */
function parseTtyChunk(chunk: Buffer): LogLine[] {
  return chunk
    .toString()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((text) => ({ stream: 'stdout' as const, text }));
}

interface MuxedParseResult {
  lines: LogLine[];
  remainder: Buffer;
}

/**
 * Parse a Docker multiplexed log buffer into individual log lines with stream metadata.
 *
 * Returns any incomplete frame bytes as `remainder` so the caller can prepend them
 * to the next chunk, preventing data loss at chunk boundaries.
 *
 * @param chunk - A buffer containing Docker's multiplexed log frames (8-byte headers followed by payloads).
 * @returns An object with parsed `lines` and any incomplete `remainder` bytes.
 */
function parseMuxedChunk(chunk: Buffer): MuxedParseResult {
  const lines: LogLine[] = [];
  let offset = 0;

  while (offset + 8 <= chunk.length) {
    const streamType = chunk[offset] === 2 ? 'stderr' : 'stdout';
    const size = chunk.readUInt32BE(offset + 4);

    if (offset + 8 + size > chunk.length) break;

    offset += 8;
    const text = chunk.subarray(offset, offset + size).toString().trimEnd();
    if (text.length > 0) {
      lines.push({ stream: streamType, text });
    }
    offset += size;
  }

  const remainder = offset < chunk.length ? chunk.subarray(offset) : Buffer.alloc(0);
  return { lines, remainder };
}
