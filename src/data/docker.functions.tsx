import { createServerFn } from '@tanstack/react-start'
import Dockerode from 'dockerode';
import { streamToAsyncIterator, mergeAsyncIterables } from '../lib/stream-utils';
import { calculateRates, clearRatesCache } from '../lib/rate-calculator';
import { dockerMiddleware } from '../middleware/docker-middleware';

export const getServerTime = createServerFn().handler(async () => {
  // This runs only on the server
  return new Date().toISOString();
});

export const getDockerContainers = createServerFn().middleware([dockerMiddleware]).handler(async ({ context }) => {
  const containers = await context.docker.listContainers({ all: true });
  return containers;
})

export const streamAllDockerContainerStats = createServerFn()
  .middleware([dockerMiddleware])
  .handler(async function* ({ context }) {
    console.log('[streamAllDockerContainerStats] Starting stream for all containers');
    const docker = context.docker;
    const streams: any[] = [];

    try {
      // Get running containers only
      const containers = await docker.listContainers({ all: false });
      console.log(`[streamAllDockerContainerStats] Found ${containers.length} running containers`);

      if (containers.length === 0) {
        console.log('[streamAllDockerContainerStats] No containers to stream');
        return;
      }

      // Create async iterable for each container
      const containerStreams = containers.map(async function* (containerInfo, index) {
        const containerName = containerInfo.Names[0]?.replace(/^\//, '') || containerInfo.Id.substring(0, 12);
        console.log(`[streamAllDockerContainerStats] Starting stream ${index} for container: ${containerName}`);

        const container = docker.getContainer(containerInfo.Id);
        const statsStream = await container.stats({ stream: true });
        streams.push(statsStream);

        try {
          for await (const stats of streamToAsyncIterator<Dockerode.ContainerStats>(statsStream)) {
            const statsWithRates = calculateRates(
              containerInfo.Id,
              containerName,
              stats
            );
            console.log(`[streamAllDockerContainerStats] Yielding stats for ${containerName}: CPU=${statsWithRates.rates.cpuPercent.toFixed(2)}%, Mem=${statsWithRates.rates.memoryPercent.toFixed(2)}%`);
            yield statsWithRates;
          }
        } catch (err) {
          console.error(`[streamAllDockerContainerStats] Error streaming container ${containerName}:`, err);
          throw err;
        } finally {
          console.log(`[streamAllDockerContainerStats] Cleaning up stream for ${containerName}`);
          if (statsStream && typeof (statsStream as any).destroy === 'function') {
            (statsStream as any).destroy();
          }
        }
      });

      // Merge and yield all streams
      console.log('[streamAllDockerContainerStats] Merging all container streams');
      yield* mergeAsyncIterables(containerStreams);
    } finally {
      // Cleanup all streams on disconnect
      console.log('[streamAllDockerContainerStats] Final cleanup - destroying all streams');
      streams.forEach(stream => {
        if (stream && typeof stream.destroy === 'function') {
          stream.destroy();
        }
      });
      clearRatesCache();
    }
  });

export const getDockerContainerStats = createServerFn().middleware([dockerMiddleware])
  .inputValidator((data: { containerId: string }) => data)
  .handler(async ({ data, context }) => {
    const container = context.docker.getContainer(data.containerId);
    return await container.stats({ stream: false });
  });
