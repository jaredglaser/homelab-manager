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
  private lastWriteTime = new Map<string, number>();

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

  /**
   * Throttle writes per entity based on collection.interval config.
   * Returns true if enough time has elapsed since the last write for this entity.
   */
  private shouldWrite(entity: string): boolean {
    const now = Date.now();
    const lastWrite = this.lastWriteTime.get(entity) ?? 0;
    if (now - lastWrite < this.config.collection.interval) return false;
    this.lastWriteTime.set(entity, now);
    return true;
  }

  protected async collectOnce(): Promise<void> {
    const t0 = performance.now();

    this.debugLog(`[${this.name}] Starting collection cycle`);

    const dockerClient = await dockerConnectionManager.getClient({
      host: this.hostConfig.host,
      port: this.hostConfig.port,
      protocol: this.hostConfig.protocol,
    });
    const tConnect = performance.now();

    const docker = dockerClient.getDocker();
    const containers = await docker.listContainers({ all: false });
    const tList = performance.now();

    if (containers.length === 0) {
      this.debugLog(`[${this.name}] No running containers found, waiting...`);
      return;
    }

    // Only upsert metadata for containers we haven't seen or that changed
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
      `[${this.name}] Monitoring ${containers.length} containers` +
      ` (connect=${(tConnect - t0).toFixed(0)}ms` +
      ` list=${(tList - tConnect).toFixed(0)}ms` +
      ` metadata=${(tMeta - tList).toFixed(0)}ms/${metadataUpdates} updated)`
    );
    this.resetBackoff();

    const streams: any[] = [];
    const containerStreams = containers.map(info => this.streamContainerStats(docker, info, streams));
    let statsReceived = 0;
    let statsWritten = 0;
    const batch: DockerStatsRow[] = [];
    let lastFlushTime = Date.now();

    try {
      for await (const stats of mergeAsyncIterables(containerStreams)) {
        if (this.signal.aborted) break;
        statsReceived++;
        const entity = `${this.hostConfig.name}/${stats.id}`;
        if (!this.shouldWrite(entity)) continue;
        statsWritten++;

        const containerName = containerInfo(containers, stats.id);
        batch.push({
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
        });

        // Flush when all containers have reported or interval has elapsed
        const now = Date.now();
        if (batch.length >= containers.length || now - lastFlushTime >= this.config.collection.interval) {
          await this.repository.insertDockerStats(batch);
          this.dbDebugLog(`[${this.name}] Wrote ${batch.length} docker rows`);
          batch.length = 0;
          lastFlushTime = now;
        }
      }

      // Flush remaining rows on stream end
      if (batch.length > 0) {
        await this.repository.insertDockerStats(batch);
        this.dbDebugLog(`[${this.name}] Wrote ${batch.length} docker rows (final)`);
      }
    } finally {
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      this.debugLog(
        `[${this.name}] Collection cycle ended after ${elapsed}s` +
        ` (received=${statsReceived} written=${statsWritten}` +
        ` streams=${streams.length} aborted=${this.signal.aborted})`
      );
      streams.forEach(stream => {
        if (stream && typeof stream.destroy === 'function') {
          stream.destroy();
        }
      });
      // Mark connection as disconnected so the connection manager
      // forces a fresh connection + ping on the next retry
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
