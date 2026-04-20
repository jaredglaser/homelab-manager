import type { Readable } from 'node:stream';
import type Dockerode from 'dockerode';
import { isContainerGone } from './stats';

/**
 * Stream a Docker container's logs to the client over a Server-Sent Events (SSE) connection.
 *
 * Uses a two-phase approach:
 * 1. **Backlog phase** - Fetches the last 200 lines without following, sends them as SSE data
 *    events, then emits a `backlog_done` event.
 * 2. **Live phase** - Opens a following stream starting from the last backlog timestamp, streaming
 *    new lines as they arrive.
 *
 * Clients MUST handle the `error` SSE event since the HTTP status is always 200
 * (the Response is returned before the async start() runs).
 *
 * @param docker - Dockerode client used to interact with the Docker daemon
 * @param containerId - The ID or name of the container whose logs will be streamed
 * @param request - The HTTP request; its abort signal is used to clean up the log stream on client disconnect
 * @returns A Response exposing an SSE stream that emits JSON-encoded log lines and error events
 */
export function handleLogStream(
  docker: Dockerode,
  containerId: string,
  request: Request
): Response {
  let closed = false;
  let activeStream: Readable | null = null;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      request.signal.addEventListener('abort', () => {
        closed = true;
        if (typeof activeStream?.destroy === 'function') {
          activeStream.destroy();
        }
        try {
          controller.close();
        } catch {
          // controller already closed
        }
      });

      try {
        const container = docker.getContainer(containerId);
        const info = await container.inspect();
        const isTty = info.Config?.Tty ?? false;

        let muxedRemainder: Buffer = Buffer.alloc(0);
        let lastTimestamp: string | null = null;

        /** Process a chunk and enqueue parsed lines. Returns parsed lines for timestamp tracking. */
        function processChunk(chunk: Buffer): LogLine[] {
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
              if (!closed) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(line)}\n\n`)
                );
              }
            }
          } catch (err) {
            if (!(err instanceof TypeError)) console.error('Unexpected error enqueuing log line:', err);
          }

          return lines;
        }

        // Capture the current time BEFORE fetching backlog so the live phase
        // `since` value covers any logs emitted during the backlog fetch.
        const fallbackSinceSeconds = Date.now() / 1000;

        /** Backlog phase: fetch tail lines without following. */
        const backlogResult = await container.logs({
          follow: false,
          stdout: true,
          stderr: true,
          tail: 200,
          timestamps: true,
        });

        // Dockerode returns a Buffer (not a stream) when follow is false
        const backlogBuffer = Buffer.isBuffer(backlogResult)
          ? backlogResult
          : Buffer.from(String(backlogResult));

        if (!closed) {
          const lines = processChunk(backlogBuffer);
          for (const line of lines) {
            const ts = extractTimestamp(line.text);
            if (ts) lastTimestamp = ts;
          }
        }

        if (closed) return;

        // Emit backlog_done separator
        controller.enqueue(encoder.encode('event: backlog_done\ndata: {}\n\n'));

        // Reset muxed remainder for the live phase
        muxedRemainder = Buffer.alloc(0);

        // Docker's `since` is inclusive and JS Date truncates to millisecond
        // precision, so the last backlog line always matches again. Bump by
        // 1 ms to make it effectively exclusive (< 1 ms gap is negligible).
        const sinceSeconds = lastTimestamp
          ? (new Date(lastTimestamp).getTime() + 1) / 1000
          : fallbackSinceSeconds;

        /** Live phase: follow new logs from the last backlog timestamp. */
        let liveStream: Readable | null = null;
        const onAbortDuringAwait = () => {
          if (liveStream && typeof liveStream.destroy === 'function') {
            liveStream.destroy();
          }
        };
        request.signal.addEventListener('abort', onAbortDuringAwait);

        liveStream = (await container.logs({
          follow: true,
          stdout: true,
          stderr: true,
          since: sinceSeconds,
          timestamps: true,
        })) as unknown as Readable;

        request.signal.removeEventListener('abort', onAbortDuringAwait);
        activeStream = liveStream;

        if (request.signal.aborted) {
          liveStream.destroy();
          return;
        }

        // Send periodic heartbeat to prevent idle socket timeouts from killing
        // the connection. Must be shorter than any intermediary timeout (Bun
        // fetch, Nitro, reverse proxies); 5 s is safe for typical defaults.
        controller.enqueue(encoder.encode(':\n\n'));
        const heartbeatInterval = setInterval(() => {
          if (closed) { clearInterval(heartbeatInterval); return; }
          try {
            controller.enqueue(encoder.encode(':\n\n'));
          } catch {
            clearInterval(heartbeatInterval);
          }
        }, 5_000);

        liveStream.on('data', (chunk: Buffer) => {
          if (closed) return;
          processChunk(chunk);
        });

        liveStream.on('end', () => {
          clearInterval(heartbeatInterval);
          if (!closed) {
            closed = true;
            controller.close();
          }
        });

        liveStream.on('error', (error: Error) => {
          clearInterval(heartbeatInterval);
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
        if (error instanceof Error && isContainerGone(error)) {
          try {
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({ error: 'Container not found', gone: true })}\n\n`
              )
            );
            closed = true;
            controller.close();
          } catch { /* controller already closed */ }
          return;
        }
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

/**
 * Extract a Docker timestamp from the beginning of a log line.
 *
 * Docker timestamps appear as the first space-delimited token and look like
 * `2026-03-29T12:30:45.123456789Z`. This function validates basic structure
 * (length > 10, dash at index 4, contains 'T').
 *
 * @param text - A log line potentially prefixed with a Docker timestamp
 * @returns The timestamp string if found, or null
 */
function extractTimestamp(text: string): string | null {
  const spaceIdx = text.indexOf(' ');
  if (spaceIdx <= 10) return null;
  const token = text.substring(0, spaceIdx);
  if (token[4] === '-' && token.includes('T')) {
    return token;
  }
  return null;
}

interface LogLine {
  stream: 'stdout' | 'stderr';
  text: string;
}

/**
 * Parse a TTY-mode Docker log chunk into individual log lines.
 *
 * Splits the chunk by newline, discards empty lines, and marks every line as `stdout`.
 * In TTY mode, Docker multiplexes stdout and stderr into a single stream with no
 * framing headers, so individual lines cannot be attributed to a specific stream.
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
