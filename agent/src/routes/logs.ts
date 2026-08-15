import type { Readable } from 'node:stream';
import type Dockerode from 'dockerode';
import { createSseStream } from '../lib/sse-stream';
import { extractTimestamp, parseMuxedChunk, parseTtyChunk, type LogLine } from '../lib/log-parse';
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
  return createSseStream(request, {
    onStart: async (emit, signal) => {
      let activeStream: Readable | null = null;
      const destroyActiveStream = () => {
        if (typeof activeStream?.destroy === 'function') {
          activeStream.destroy();
        }
      };

      try {
        const container = docker.getContainer(containerId);
        const info = await container.inspect();
        const isTty = info.Config?.Tty ?? false;

        let muxedRemainder: Buffer = Buffer.alloc(0);
        let lastTimestamp: string | null = null;

        /** Process a chunk and emit parsed lines. Returns parsed lines for timestamp tracking. */
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

          for (const line of lines) {
            emit.data(line);
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

        for (const line of processChunk(backlogBuffer)) {
          const ts = extractTimestamp(line.text);
          if (ts) lastTimestamp = ts;
        }

        if (signal.aborted) return destroyActiveStream;

        emit.event('backlog_done', {});

        // Reset muxed remainder for the live phase
        muxedRemainder = Buffer.alloc(0);

        // Docker's `since` is inclusive and JS Date truncates to millisecond
        // precision, so the last backlog line always matches again. Bump by
        // 1 ms to make it effectively exclusive (< 1 ms gap is negligible).
        const sinceSeconds = lastTimestamp
          ? (new Date(lastTimestamp).getTime() + 1) / 1000
          : fallbackSinceSeconds;

        /** Live phase: follow new logs from the last backlog timestamp. */
        // @types/dockerode 4.0.1 types logs() stream result as any; cast required to use Readable API
        const liveStream = (await container.logs({
          follow: true,
          stdout: true,
          stderr: true,
          since: sinceSeconds,
          timestamps: true,
        })) as unknown as Readable;

        activeStream = liveStream;

        if (signal.aborted) {
          liveStream.destroy();
          return destroyActiveStream;
        }

        liveStream.on('data', (chunk: Buffer) => {
          processChunk(chunk);
        });

        liveStream.on('end', () => {
          // Signal to the client that the stream ended cleanly (container stopped)
          // so it can suppress the reconnect loop.
          emit.event('stream_end', {});
          emit.close();
        });

        liveStream.on('error', (error: Error) => {
          console.error(`Log stream error for container ${containerId}:`, error);
          emit.event('error', { error: error.message });
          emit.close();
        });

        return destroyActiveStream;
      } catch (error) {
        if (error instanceof Error && isContainerGone(error)) {
          emit.event('error', { error: 'Container not found', gone: true });
        } else {
          console.error(`Failed to start log stream for container ${containerId}:`, error);
          emit.event('error', { error: error instanceof Error ? error.message : String(error) });
        }
        emit.close();
        return destroyActiveStream;
      }
    },
  });
}
