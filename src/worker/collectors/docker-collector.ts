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
    const elapsed = now - lastWrite;
    if (elapsed < this.config.collection.interval) {
      this.debugLog(
        `[${this.name}] shouldWrite SKIP ${entity.split('/').pop()?.substring(0, 12)}` +
        ` (${elapsed}ms since last, interval=${this.config.collection.interval}ms)`
      );
      return false;
    }
    this.lastWriteTime.set(entity, now);
    return true;
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
    let flushCount = 0;
    const batch: DockerStatsRow[] = [];
    let lastFlushTime = Date.now();
    let lastContainerCheckTime = Date.now();
    const CONTAINER_REFRESH_INTERVAL_MS = 60_000; // Check for new/stopped containers every 60s

    try {
      // Keep collecting stats until aborted
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

        // Flush based on interval (not container count, for consistent timing)
        const now = Date.now();
        const timeSinceFlush = now - lastFlushTime;

        if (timeSinceFlush >= this.config.collection.interval) {
          flushCount++;
          const t0Flush = performance.now();
          await this.repository.insertDockerStats(batch);
          const flushMs = (performance.now() - t0Flush).toFixed(0);
          this.dbDebugLog(
            `[${this.name}] Flush #${flushCount}: wrote ${batch.length} rows in ${flushMs}ms` +
            ` (${statsReceived} received, ${statsWritten} written)`
          );
          batch.length = 0;
          lastFlushTime = now;
        }

        // Periodically check for new/stopped containers (every 60s)
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

      // Flush any remaining rows
      if (batch.length > 0) {
        await this.repository.insertDockerStats(batch);
        this.dbDebugLog(`[${this.name}] Final flush: wrote ${batch.length} rows`);
      }
    } finally {
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      this.debugLog(
        `[${this.name}] Collection ended after ${elapsed}s` +
        ` (${statsReceived} stats received, ${statsWritten} written, ${flushCount} flushes,` +
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
