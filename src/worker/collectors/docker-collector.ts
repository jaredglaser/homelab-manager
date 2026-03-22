import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { DockerHostConfig } from '@/lib/config/docker-config';
import { dockerConnectionManager } from '@/lib/clients/docker-client';
import { DockerRateCalculator } from '@/lib/rate-calculator';
import type { ContainerStatsWithRates } from '@/lib/rate-calculator';
import type { DockerStatsRow } from '@/types/docker';
import { streamToAsyncIterator, mergeAsyncIterables } from '@/lib/stream-utils';
import { computeServiceKey } from '@/lib/utils/docker-hierarchy-builder';
import type Dockerode from 'dockerode';
import { BaseCollector } from './base-collector';

const DOCKER_SOURCE = 'docker';
const CONTAINER_REFRESH_INTERVAL_MS = 60_000;

export class DockerCollector extends BaseCollector {
  readonly name: string;
  private readonly calculator = new DockerRateCalculator();
  private readonly hostConfig: DockerHostConfig;
  private knownContainers = new Map<string, { name: string; image: string; serviceKey: string }>();

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
    const containers = await docker.listContainers({ all: false });
    const tList = performance.now();

    if (containers.length === 0) {
      this.debugLog(`[${this.name}] No running containers found, will retry...`);
      await dockerClient.close();
      return;
    }

    const metadataUpdates = await this.upsertContainerMetadata(containers);
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

    try {
      // Keep collecting stats until aborted - stream inserts directly to database
      for await (const stats of mergeAsyncIterables(containerStreams)) {
        if (this.signal.aborted) break;

        statsReceived++;
        statsWritten++;

        const row = this.buildStatsRow(stats, containers);

        // Write immediately to database (no batching)
        const t0Write = performance.now();
        await this.repository.insertDockerStats([row]);
        const writeMs = (performance.now() - t0Write).toFixed(1);
        this.dbDebugLog(
          `[${this.name}] Wrote stat for ${row.container_name} in ${writeMs}ms (total: ${statsWritten})`
        );

        // Periodically check for new/stopped containers
        const now = Date.now();
        if (now - lastContainerCheckTime >= CONTAINER_REFRESH_INTERVAL_MS) {
          try {
            const changes = await this.checkForContainerChanges(docker, containers);
            if (changes.changed) {
              this.debugLog(
                `[${this.name}] Container changes detected: +${changes.added} added, -${changes.removed} removed` +
                ` (will reconnect to refresh streams)`
              );
              break;
            }
          } catch (err) {
            console.error(
              `[${this.name}] Container refresh check failed, will retry next cycle:`,
              err instanceof Error ? err.message : String(err)
            );
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

  /**
   * Upsert metadata (name, image, service_key) for all containers.
   * Handles service key migration when compose labels appear or change.
   * Maintains `this.knownContainers` to track per-container state across collection cycles.
   */
  private async upsertContainerMetadata(containers: Dockerode.ContainerInfo[]): Promise<number> {
    let metadataUpdates = 0;

    for (const info of containers) {
      const containerName = info.Names[0]?.replace(/^\//, '') || info.Id.substring(0, 12);
      const entityPath = `${this.hostConfig.name}/${info.Id}`;
      const labels = info.Labels ?? {};
      const composeService = labels['com.docker.compose.service'];
      const serviceKey = computeServiceKey(labels, containerName);
      const known = this.knownContainers.get(info.Id);

      // Upsert name/image only when they actually changed
      if (!known || known.name !== containerName || known.image !== info.Image) {
        await this.repository.upsertEntityMetadata(DOCKER_SOURCE, entityPath, 'name', containerName);
        await this.repository.upsertEntityMetadata(DOCKER_SOURCE, entityPath, 'image', info.Image);
        metadataUpdates++;
      }

      // Upsert service_key and attempt migration only when serviceKey changed
      if (!known || known.serviceKey !== serviceKey) {
        await this.repository.upsertEntityMetadata(DOCKER_SOURCE, entityPath, 'service_key', serviceKey);
        // When compose labels appear (or the service_key changes), migrate old name-only entries
        // so history and icons accumulated before adding labels are linked to the new key.
        // Icon is also copied from old entity to new so it survives the migration.
        // Note: removing compose labels does NOT revert the service_key - the container
        // retains its compose-based key until it is recreated without labels.
        if (composeService) {
          // Use the previously-known service_key as the old key (e.g. "plex-1" for a container
          // whose name differs from the compose service label). Fall back to the container name
          // when this is the first time the worker has seen this container.
          const oldServiceKey = known?.serviceKey ?? containerName;
          try {
            await this.repository.migrateServiceKeyByName(
              DOCKER_SOURCE, this.hostConfig.name, oldServiceKey, serviceKey,
            );
            await this.repository.migrateServiceIcon(
              DOCKER_SOURCE,
              `${this.hostConfig.name}/${oldServiceKey}`,
              `${this.hostConfig.name}/${serviceKey}`,
            );
          } catch (err) {
            console.error(`[${this.name}] Failed to migrate service key ${oldServiceKey} → ${serviceKey}:`, err);
            // Preserve updated name/image but old serviceKey so the next cycle only retries
            // the service_key upsert + migration, not name/image
            this.knownContainers.set(info.Id, { name: containerName, image: info.Image, serviceKey: known?.serviceKey ?? containerName });
            continue;
          }
        }
        metadataUpdates++;
      }

      this.knownContainers.set(info.Id, { name: containerName, image: info.Image, serviceKey });
    }

    return metadataUpdates;
  }

  /** Build a database row from a stats event, looking up the container name from the container list and the image from `this.knownContainers`. */
  private buildStatsRow(stats: ContainerStatsWithRates, containers: Dockerode.ContainerInfo[]): DockerStatsRow {
    const name = findContainerName(containers, stats.id);
    return {
      time: new Date(),
      host: this.hostConfig.name,
      container_id: stats.id,
      container_name: name,
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
  }

  /** Check whether containers have been added or removed since the last snapshot. */
  private async checkForContainerChanges(
    docker: Dockerode,
    previousContainers: Dockerode.ContainerInfo[],
  ): Promise<{ changed: boolean; added: number; removed: number }> {
    const currentContainers = await docker.listContainers({ all: false });
    const currentIds = new Set(currentContainers.map(c => c.Id));
    const previousIds = new Set(previousContainers.map(c => c.Id));

    const added = currentContainers.filter(c => !previousIds.has(c.Id)).length;
    const removed = previousContainers.filter(c => !currentIds.has(c.Id)).length;

    return { changed: added > 0 || removed > 0, added, removed };
  }

  private async *streamContainerStats(
    docker: Dockerode,
    containerInfo: Dockerode.ContainerInfo,
    streams: any[],
  ): AsyncGenerator<ContainerStatsWithRates> {
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
function findContainerName(containers: Dockerode.ContainerInfo[], id: string): string {
  const info = containers.find(c => c.Id === id);
  return info?.Names[0]?.replace(/^\//, '') || id.substring(0, 12);
}
