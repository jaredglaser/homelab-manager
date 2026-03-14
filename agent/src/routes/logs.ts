import type Dockerode from 'dockerode';

export function handleLogStream(
  docker: Dockerode,
  containerId: string,
  request: Request
): Response {
  let closed = false;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      request.signal.addEventListener('abort', () => {
        closed = true;
        controller.close();
      });

      try {
        const container = docker.getContainer(containerId);
        const info = await container.inspect();
        const isTty = info.Config?.Tty ?? false;

        const logStream = (await container.logs({
          follow: true,
          stdout: true,
          stderr: true,
          tail: 200,
          timestamps: true,
        })) as NodeJS.ReadableStream;

        logStream.on('data', (chunk: Buffer) => {
          if (closed) return;

          const lines = isTty
            ? parseTtyChunk(chunk)
            : parseMuxedChunk(chunk);

          for (const line of lines) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(line)}\n\n`)
            );
          }
        });

        logStream.on('end', () => {
          if (!closed) {
            closed = true;
            controller.close();
          }
        });

        logStream.on('error', (error: Error) => {
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
        const msg = error instanceof Error ? error.message : String(error);
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`
          )
        );
        controller.close();
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

function parseTtyChunk(chunk: Buffer): LogLine[] {
  return chunk
    .toString()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((text) => ({ stream: 'stdout' as const, text }));
}

function parseMuxedChunk(chunk: Buffer): LogLine[] {
  const lines: LogLine[] = [];
  let offset = 0;

  while (offset + 8 <= chunk.length) {
    const streamType = chunk[offset] === 2 ? 'stderr' : 'stdout';
    const size = chunk.readUInt32BE(offset + 4);
    offset += 8;

    if (offset + size > chunk.length) break;

    const text = chunk.subarray(offset, offset + size).toString().trimEnd();
    if (text.length > 0) {
      lines.push({ stream: streamType, text });
    }
    offset += size;
  }

  return lines;
}
