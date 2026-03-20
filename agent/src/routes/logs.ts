import type { Readable } from 'node:stream';
import type Dockerode from 'dockerode';

/** Shared mutable state for a single SSE log session. */
interface LogStreamContext {
  closed: boolean;
  readonly encoder: TextEncoder;
  logStream: Readable | null;
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
}

/** Enqueue an SSE message, silently swallowing enqueue-after-close TypeError. */
function sendLogSSE(ctx: LogStreamContext, data: string, event?: string): void {
  if (ctx.closed) return;
  try {
    const prefix = event ? `event: ${event}\n` : '';
    ctx.controller.enqueue(ctx.encoder.encode(`${prefix}data: ${data}\n\n`));
  } catch (err) {
    if (!(err instanceof TypeError)) console.error('Unexpected error enqueuing log line:', err);
  }
}

/** Enqueue a JSON error payload as an SSE error event. */
function sendLogErrorSSE(ctx: LogStreamContext, error: string): void {
  sendLogSSE(ctx, JSON.stringify({ error }), 'error');
}

/**
 * Wire up `data`, `end`, and `error` event listeners on a Docker log stream.
 *
 * Parses incoming chunks using the appropriate parser (TTY vs multiplexed) and
 * forwards parsed log lines as SSE data events. Closes the stream on end or error.
 *
 * @param ctx - The shared log stream context
 * @param logStream - The Node.js Readable stream from Docker's log API
 * @param isTty - Whether the container is running in TTY mode
 * @param containerId - Container ID used for error messages
 */
function wireLogStreamEvents(
  ctx: LogStreamContext,
  logStream: Readable,
  isTty: boolean,
  containerId: string,
): void {
  let muxedRemainder: Buffer = Buffer.alloc(0);

  logStream.on('data', (chunk: Buffer) => {
    if (ctx.closed) return;

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

    for (const line of lines) {
      sendLogSSE(ctx, JSON.stringify(line));
    }
  });

  logStream.on('end', () => {
    if (!ctx.closed) {
      ctx.closed = true;
      ctx.controller.close();
    }
  });

  logStream.on('error', (error: Error) => {
    console.error(`Log stream error for container ${containerId}:`, error);
    if (!ctx.closed) {
      sendLogErrorSSE(ctx, error.message);
      ctx.closed = true;
      ctx.controller.close();
    }
  });
}

/**
 * Stream a Docker container's logs to the client over a Server-Sent Events (SSE) connection.
 *
 * Streams recent and live stdout/stderr output from the specified container as SSE `data` events
 * containing JSON-encoded log objects; emits SSE `error` events on failures and closes the stream
 * when the request is aborted or the log stream ends.
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
  const stream = new ReadableStream({
    async start(controller) {
      const ctx: LogStreamContext = {
        closed: false,
        encoder: new TextEncoder(),
        logStream: null,
        controller,
      };

      request.signal.addEventListener('abort', () => {
        ctx.closed = true;
        if (typeof ctx.logStream?.destroy === 'function') {
          ctx.logStream.destroy();
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

        ctx.logStream = (await container.logs({
          follow: true,
          stdout: true,
          stderr: true,
          tail: 200,
          timestamps: true,
        })) as unknown as Readable;

        wireLogStreamEvents(ctx, ctx.logStream, isTty, containerId);
      } catch (error) {
        console.error(`Failed to start log stream for container ${containerId}:`, error);
        const msg = error instanceof Error ? error.message : String(error);
        sendLogErrorSSE(ctx, msg);
        ctx.closed = true;
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
