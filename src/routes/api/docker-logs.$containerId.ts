import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/docker-logs/$containerId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { authenticateSSE } = await import('@/lib/auth/sse-auth');
        const user = await authenticateSSE(request);
        if (!user) {
          return new Response('Unauthorized', { status: 401 });
        }

        const { loadDockerConfig } = await import('@/lib/config/docker-config');
        const { dockerConnectionManager } = await import('@/lib/clients/docker-client');
        const { parseMuxedChunk, parseTtyChunk } = await import('@/lib/utils/docker-log-demux');

        const { containerId } = params;
        const url = new URL(request.url);
        const hostName = url.searchParams.get('host');

        if (!hostName) {
          return new Response('Missing host query parameter', { status: 400 });
        }

        const config = loadDockerConfig();
        const hostConfig = config.hosts.find((h) => h.name === hostName);
        if (!hostConfig) {
          return new Response(`Unknown Docker host: ${hostName}`, { status: 404 });
        }

        const encoder = new TextEncoder();
        let closed = false;

        const stream = new ReadableStream({
          start(controller) {
            const sendLines = (lines: { text: string; stream: string }[]) => {
              if (closed || lines.length === 0) return;
              try {
                const message = `data: ${JSON.stringify({ lines })}\n\n`;
                controller.enqueue(encoder.encode(message));
              } catch {
                closed = true;
              }
            };

            const sendError = (msg: string) => {
              if (closed) return;
              try {
                controller.enqueue(
                  encoder.encode(`event: log_error\ndata: ${JSON.stringify({ message: msg })}\n\n`),
                );
              } catch {
                closed = true;
              }
            };

            void (async () => {
              try {
                const client = await dockerConnectionManager.getClient(hostConfig);
                const docker = client.getDocker();
                const container = docker.getContainer(containerId);

                // Check if container uses TTY to determine demux mode
                const info = await container.inspect();
                const isTty = info.Config.Tty === true;

                const logStream = await container.logs({
                  follow: true,
                  stdout: true,
                  stderr: true,
                  tail: 200,
                });

                // Node.js stream from Dockerode
                const nodeStream = logStream as unknown as import('stream').Readable;
                let remainder = Buffer.alloc(0) as Buffer;

                nodeStream.on('data', (chunk: Buffer) => {
                  if (closed) return;

                  if (isTty) {
                    const lines = parseTtyChunk(chunk.toString('utf-8'));
                    sendLines(lines);
                  } else {
                    const combined = remainder.length > 0
                      ? Buffer.concat([remainder, chunk])
                      : chunk;
                    const result = parseMuxedChunk(combined);
                    remainder = result.remainder;
                    sendLines(result.lines);
                  }
                });

                nodeStream.on('error', (err: Error) => {
                  sendError(err.message);
                });

                nodeStream.on('end', () => {
                  if (!closed) {
                    sendLines([{ text: '--- Container log stream ended ---', stream: 'stdout' }]);
                    closed = true;
                    try {
                      controller.close();
                    } catch {
                      // Already closed
                    }
                  }
                });

                request.signal.addEventListener('abort', () => {
                  closed = true;
                  nodeStream.destroy();
                  try {
                    controller.close();
                  } catch {
                    // Already closed
                  }
                });
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                sendError(msg);
              }
            })();
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        });
      },
    },
  },
});
