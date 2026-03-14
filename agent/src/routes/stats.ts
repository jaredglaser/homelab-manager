import type Dockerode from 'dockerode';
import { RateCalculator } from '../rate-calculator';

const POLL_INTERVAL_MS = 1000;

export function handleStatsStream(docker: Dockerode, request: Request): Response {
  let closed = false;
  const rateCalculator = new RateCalculator();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      request.signal.addEventListener('abort', () => {
        closed = true;
        rateCalculator.clear();
        controller.close();
      });

      const poll = async () => {
        while (!closed) {
          try {
            const containers = await docker.listContainers({ all: false });
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
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
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
