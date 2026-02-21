import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { DockerHostConfig } from '@/lib/config/docker-config';
import { dockerConnectionManager } from '@/lib/clients/docker-client';
import { DockerRateCalculator } from '@/lib/rate-calculator';
import type { DockerStatsRow } from '@/types/docker';
import { streamToAsyncIterator, mergeAsyncIterables } from '@/lib/stream-utils';
import type Dockerode from 'dockerode';
import { BaseCollector } from './base-collector';

const DOCKER_SOURCE = 'docker';

export class DockerCollector extends BaseCollector {
  readonly name: string;
  private readonly calculator = new DockerRateCalculator();
  private readonly hostConfig: DockerHostConfig;
  private knownContainers = new Map<string, { name: string; image: string }>();

  constructor(
    db: DatabaseClient,
    config: WorkerConfig,
    hostConfig: DockerHostConfig,
    abortController?: AbortController
  ) {
    super(db, config, abortController);
    this.hostConfig = hostConfig;
    this.name = `DockerCollector[${hostConfig.name}]`;
  }

  protected isConfigured(): boolean {
    return !!this.hostConfig.host;
  }

  protected async collect(): Promise<void> {
    const t0 = performance.now();
    this.debugLog(`[${this.name}] Starting continuous collection (streams will stay open)`);

    const dockerClient = await dockerConnectionManager.getClient({
      host: this.hostConfig.host,
      port: this.hostConfig.port,
      protocol: this.hostConfig.protocol,
    });
    const tConnect = performance.now();

    const docker = dockerClient.getDocker();
    let containers = await docker.listContainers({ all: false });
    const tList = performance.now();

    if (containers.length === 0) {
      this.debugLog(`[${this.name}] No running containers found, will retry...`);
      await dockerClient.close();
      return;
    }

    // Upsert metadata for all containers
    let metadataUpdates = 0;
    for (const containerInfo of containers) {
      const containerName = containerInfo.Names[0]?.replace(/^\//, '') || containerInfo.Id.substring(0, 12);
      const entityPath = `${this.hostConfig.name}/${containerInfo.Id}`;
      const known = this.knownContainers.get(containerInfo.Id);

      if (!known || known.name !== containerName || known.image !== containerInfo.Image) {
        await this.repository.upsertEntityMetadata(DOCKER_SOURCE, entityPath, 'name', containerName);
        await this.repository.upsertEntityMetadata(DOCKER_SOURCE, entityPath, 'image', containerInfo.Image);
        this.knownContainers.set(containerInfo.Id, { name: containerName, image: containerInfo.Image });
        metadataUpdates++;
      }
    }
    const tMeta = performance.now();

    this.debugLog(
      `[${this.name}] Starting streams for ${containers.length} containers` +
      ` (connect=${(tConnect - t0).toFixed(0)}ms` +
      ` list=${(tList - tConnect).toFixed(0)}ms` +
      ` metadata=${(tMeta - tList).toFixed(0)}ms/${metadataUpdates} updated)`
    );
    this.resetBackoff();

    const streams: any[] = [];
    const containerStreams = containers.map(info => this.streamContainerStats(docker, info, streams));
    let statsReceived = 0;
    let statsWritten = 0;
    let lastContainerCheckTime = Date.now();
    const CONTAINER_REFRESH_INTERVAL_MS = 60_000; // Check for new/stopped containers every 60s

    try {
      // Keep collecting stats until aborted - stream inserts directly to database
      for await (const stats of mergeAsyncIterables(containerStreams)) {
        if (this.signal.aborted) break;

        statsReceived++;
        statsWritten++;

        const containerName = containerInfo(containers, stats.id);
        const row: DockerStatsRow = {
          time: new Date(),
          host: this.hostConfig.name,
          container_id: stats.id,
          container_name: containerName,
          image: this.knownContainers.get(stats.id)?.image ?? null,
          cpu_percent: stats.rates.cpuPercent,
          memory_usage: stats.memory_stats?.usage || 0,
          memory_limit: stats.memory_stats?.limit || 0,
          memory_percent: stats.rates.memoryPercent,
          network_rx_bytes_per_sec: stats.rates.networkRxBytesPerSec,
          network_tx_bytes_per_sec: stats.rates.networkTxBytesPerSec,
          block_io_read_bytes_per_sec: stats.rates.blockIoReadBytesPerSec,
          block_io_write_bytes_per_sec: stats.rates.blockIoWriteBytesPerSec,
        };

        // Write immediately to database (no batching)
        const t0Write = performance.now();
        await this.repository.insertDockerStats([row]);
        const writeMs = (performance.now() - t0Write).toFixed(1);
        this.dbDebugLog(
          `[${this.name}] Wrote stat for ${containerName} in ${writeMs}ms (total: ${statsWritten})`
        );

        // Periodically check for new/stopped containers (every 60s)
        const now = Date.now();
        const timeSinceContainerCheck = now - lastContainerCheckTime;
        if (timeSinceContainerCheck >= CONTAINER_REFRESH_INTERVAL_MS) {
          const currentContainers = await docker.listContainers({ all: false });
          const currentIds = new Set(currentContainers.map(c => c.Id));
          const previousIds = new Set(containers.map(c => c.Id));

          const added = currentContainers.filter(c => !previousIds.has(c.Id));
          const removed = containers.filter(c => !currentIds.has(c.Id));

          if (added.length > 0 || removed.length > 0) {
            this.debugLog(
              `[${this.name}] Container changes detected: +${added.length} added, -${removed.length} removed` +
              ` (will reconnect to refresh streams)`
            );
            // Exit to reconnect with fresh container list
            break;
          }

          lastContainerCheckTime = now;
        }
      }
    } finally {
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      this.debugLog(
        `[${this.name}] Collection ended after ${elapsed}s` +
        ` (${statsReceived} stats received, ${statsWritten} written,` +
        ` aborted=${this.signal.aborted})`
      );

      // Clean up streams
      streams.forEach(stream => {
        if (stream && typeof stream.destroy === 'function') {
          stream.destroy();
        }
      });

      await dockerClient.close();
    }
  }

  private async *streamContainerStats(
    docker: Dockerode,
    containerInfo: Dockerode.ContainerInfo,
    streams: any[],
  ): AsyncGenerator<import('@/lib/rate-calculator').ContainerStatsWithRates> {
    const containerName = containerInfo.Names[0]?.replace(/^\//, '') || containerInfo.Id.substring(0, 12);
    const shortId = containerInfo.Id.substring(0, 12);
    let eventsReceived = 0;

    try {
      this.debugLog(`[${this.name}] Opening stats stream for ${containerName} (${shortId})`);
      const t0 = performance.now();
      const container = docker.getContainer(containerInfo.Id);
      const statsStream = await container.stats({ stream: true });
      streams.push(statsStream);
      const elapsed = (performance.now() - t0).toFixed(0);
      this.debugLog(`[${this.name}] Stats stream opened for ${containerName} (${elapsed}ms)`);

      for await (const stats of streamToAsyncIterator<Dockerode.ContainerStats>(statsStream)) {
        if (this.signal.aborted) break;
        eventsReceived++;

        yield this.calculator.calculate(containerInfo.Id, {
          containerId: containerInfo.Id,
          containerName,
          stats,
        });
      }
      this.debugLog(
        `[${this.name}] Stream ended normally for ${containerName} (${shortId})` +
        ` after ${eventsReceived} events, aborted=${this.signal.aborted}`
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errCode = (err as any)?.code || 'unknown';
      const errStatusCode = (err as any)?.statusCode || 'none';
      console.error(
        `[${this.name}] Stream error for ${containerName} (${shortId}):` +
        ` code=${errCode} statusCode=${errStatusCode} message=${errMsg}` +
        ` (after ${eventsReceived} events)`
      );
    }
  }
}

/** Find container name by ID from the container list */
function containerInfo(containers: Dockerode.ContainerInfo[], id: string): string {
  const info = containers.find(c => c.Id === id);
  return info?.Names[0]?.replace(/^\//, '') || id.substring(0, 12);
}
