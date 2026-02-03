import { createServerFn } from '@tanstack/react-start'
import Dockerode from 'dockerode';
import { streamToAsyncIterator, mergeAsyncIterables } from '../lib/stream-utils';
import { DockerRateCalculator } from '../lib/rate-calculator';
import { dockerMiddleware } from '../middleware/docker-middleware';

const rateCalculator = new DockerRateCalculator();

export const getServerTime = createServerFn().handler(async () => {
  return new Date().toISOString();
});

export const getDockerContainers = createServerFn().middleware([dockerMiddleware]).handler(async ({ context }) => {
  const containers = await context.docker.listContainers({ all: true });
  return containers;
})

export const streamAllDockerContainerStats = createServerFn()
  .middleware([dockerMiddleware])
  .handler(async function* ({ context }) {
    const docker = context.docker;
    const streams: any[] = [];

    try {
      const containers = await docker.listContainers({ all: false });

      if (containers.length === 0) {
        return;
      }

      const containerStreams = containers.map(async function* (containerInfo) {
        const containerName = containerInfo.Names[0]?.replace(/^\//, '') || containerInfo.Id.substring(0, 12);

        const container = docker.getContainer(containerInfo.Id);
        const statsStream = await container.stats({ stream: true });
        streams.push(statsStream);

        try {
          for await (const stats of streamToAsyncIterator<Dockerode.ContainerStats>(statsStream)) {
            const statsWithRates = rateCalculator.calculate(
              containerInfo.Id,
              {
                containerId: containerInfo.Id,
                containerName,
                stats,
              }
            );
            yield statsWithRates;
          }
        } finally {
          if (statsStream && typeof (statsStream as any).destroy === 'function') {
            (statsStream as any).destroy();
          }
        }
      });

      yield* mergeAsyncIterables(containerStreams);
    } finally {
      streams.forEach(stream => {
        if (stream && typeof stream.destroy === 'function') {
          stream.destroy();
        }
      });
      rateCalculator.clear();
    }
  });

export const getDockerContainerStats = createServerFn().middleware([dockerMiddleware])
  .inputValidator((data: { containerId: string }) => data)
  .handler(async ({ data, context }) => {
    const container = context.docker.getContainer(data.containerId);
    return await container.stats({ stream: false });
  });
