import type { Readable } from 'node:stream';
import type Dockerode from 'dockerode';

const CONTAINER_REFRESH_INTERVAL_MS = 60_000;

export function handleStatsStream(docker: Dockerode, request: Request): Response {
  let closed = false;
  const encoder = new TextEncoder();
  const containerStreams = new Map<string, Readable>();

  const stream = new ReadableStream({
    async start(controller) {
      request.signal.addEventListener('abort', () => {
        closed = true;
        for (const s of containerStreams.values()) {
          if (typeof s.destroy === 'function') s.destroy();
        }
        containerStreams.clear();
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
            containerStreams.set(id, readable);

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
              console.error(`Stats stream error for container ${id}:`, error.message);
              if (!closed) {
                try {
                  controller.enqueue(
                    encoder.encode(`event: container-error\ndata: ${JSON.stringify({ containerId: id, error: error.message })}\n\n`)
                  );
                } catch {
                  // enqueue-after-close race
                }
              }
              containerStreams.delete(id);
            });

            readable.on('end', () => {
              containerStreams.delete(id);
            });
          }).catch((error: Error) => {
            if (!closed) {
              try {
                controller.enqueue(
                  encoder.encode(`event: container-error\ndata: ${JSON.stringify({ containerId: id, error: error.message })}\n\n`)
                );
              } catch {
                // enqueue-after-close race
              }
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

            // Destroy streams for removed containers
            for (const prevId of previousIds) {
              if (!currentIds.has(prevId)) {
                const stale = containerStreams.get(prevId);
                if (stale && typeof stale.destroy === 'function') stale.destroy();
                containerStreams.delete(prevId);
              }
            }

            for (const c of current) {
              if (!previousIds.has(c.Id)) openStream(c);
            }

            containers = current;

            if (!closed) {
              try {
                controller.enqueue(
                  encoder.encode(`event: containers\ndata: ${JSON.stringify({ ids: [...currentIds] })}\n\n`)
                );
              } catch {
                // enqueue-after-close race
              }
            }
          } catch (error) {
            console.error('Failed to refresh container list:', error);
            if (!closed) {
              try {
                const msg = error instanceof Error ? error.message : String(error);
                controller.enqueue(
                  encoder.encode(`event: container-error\ndata: ${JSON.stringify({ error: msg, type: 'refresh_failed' })}\n\n`)
                );
              } catch {
                // enqueue-after-close race
              }
            }
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
