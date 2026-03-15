import type { Readable } from 'node:stream';
import type Dockerode from 'dockerode';

const CONTAINER_REFRESH_INTERVAL_MS = 60_000;

export function handleStatsStream(docker: Dockerode, request: Request): Response {
  let closed = false;
  const encoder = new TextEncoder();
  const containerStreams: Readable[] = [];

  const stream = new ReadableStream({
    async start(controller) {
      request.signal.addEventListener('abort', () => {
        closed = true;
        for (const s of containerStreams) {
          if (typeof s.destroy === 'function') s.destroy();
        }
        try {
          controller.close();
        } catch {
          // controller may already be closed
        }
      });

      try {
        let containers = await docker.listContainers({ all: false });
        let lastRefresh = Date.now();

        const openStream = (containerInfo: Dockerode.ContainerInfo) => {
          const id = containerInfo.Id;
          const name = containerInfo.Names[0]?.replace(/^\//, '') ?? id;
          const image = containerInfo.Image;
          const container = docker.getContainer(id);

          container.stats({ stream: true }).then((statsStream) => {
            const readable = statsStream as unknown as Readable;
            containerStreams.push(readable);

            let buffer = '';
            readable.on('data', (chunk: Buffer) => {
              if (closed) return;
              buffer += chunk.toString();

              let newlineIdx;
              while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newlineIdx).trim();
                buffer = buffer.slice(newlineIdx + 1);
                if (!line) continue;

                try {
                  const stats = JSON.parse(line);
                  const event = { containerId: id, containerName: name, image, stats };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                } catch {
                  // malformed JSON frame, skip
                }
              }
            });

            readable.on('error', (error: Error) => {
              if (!closed) {
                controller.enqueue(
                  encoder.encode(`event: container-error\ndata: ${JSON.stringify({ containerId: id, error: error.message })}\n\n`)
                );
              }
            });

            readable.on('end', () => {
              const idx = containerStreams.indexOf(readable);
              if (idx !== -1) containerStreams.splice(idx, 1);
            });
          }).catch((error: Error) => {
            if (!closed) {
              controller.enqueue(
                encoder.encode(`event: container-error\ndata: ${JSON.stringify({ containerId: id, error: error.message })}\n\n`)
              );
            }
          });
        };

        for (const c of containers) {
          openStream(c);
        }

        // Periodically check for container changes
        while (!closed) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          if (closed) break;

          const now = Date.now();
          if (now - lastRefresh < CONTAINER_REFRESH_INTERVAL_MS) continue;
          lastRefresh = now;

          try {
            const current = await docker.listContainers({ all: false });
            const currentIds = new Set(current.map(c => c.Id));
            const previousIds = new Set(containers.map(c => c.Id));

            for (const c of current) {
              if (!previousIds.has(c.Id)) openStream(c);
            }

            containers = current;

            if (!closed) {
              controller.enqueue(
                encoder.encode(`event: containers\ndata: ${JSON.stringify({ ids: [...currentIds] })}\n\n`)
              );
            }
          } catch {
            // transient error listing containers, will retry next interval
          }
        }
      } catch (error) {
        if (!closed) {
          const msg = error instanceof Error ? error.message : String(error);
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`));
          controller.close();
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
