import type Dockerode from 'dockerode';
import { RateCalculator } from '../rate-calculator';

const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * Open a Server-Sent Events stream that periodically polls Docker containers for stats and emits per-container usage rate events.
 *
 * @param docker - Dockerode client used to list containers and retrieve stats
 * @param request - Incoming Request whose abort signal will stop the stream
 * @param pollIntervalMs - Interval in milliseconds between polls (defaults to 1000)
 * @returns A Response whose body is an SSE ReadableStream. The stream emits `data` events containing objects with `containerId`, `containerName`, `image`, computed rate fields, and `timestamp`. On errors the stream emits an `error` event with `{ error: string }`
 */
export function handleStatsStream(
  docker: Dockerode,
  request: Request,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
): Response {
  let closed = false;
  const rateCalculator = new RateCalculator();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      request.signal.addEventListener('abort', () => {
        closed = true;
        rateCalculator.clear();
        try {
          controller.close();
        } catch {
          // controller may already be closed if the poll loop exited first
        }
      });

      const poll = async () => {
        while (!closed) {
          try {
            const containers = await docker.listContainers({ all: false });
            const activeIds = new Set(containers.map((c) => c.Id));
            rateCalculator.pruneExcept(activeIds);
            const snapshots = await Promise.allSettled(
              containers.map(async (container) => {
                const dockerContainer = docker.getContainer(container.Id);
                const stats = await dockerContainer.stats({ stream: false });
                return { container, stats };
              })
            );

            for (const result of snapshots) {
              if (closed) break;
              if (result.status !== 'fulfilled') continue;
              const { container, stats } = result.value;
              const id = container.Id;
              const name = container.Names[0]?.replace(/^\//, '') ?? id;
              const rates = rateCalculator.calculate(id, stats);
              if (!rates) continue;

              const data = {
                containerId: id,
                containerName: name,
                image: container.Image,
                ...rates,
                timestamp: new Date().toISOString(),
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            }
          } catch (error) {
            if (!closed) {
              const msg = error instanceof Error ? error.message : String(error);
              controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`));
            }
          }

          if (!closed) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          }
        }
      };

      poll();
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
