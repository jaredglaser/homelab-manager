import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { DockerHostConfig } from '@/lib/config/docker-config';
import { dockerConnectionManager } from '@/lib/clients/docker-client';
import { DockerRateCalculator, type ContainerStatsWithRates } from '@/lib/rate-calculator';
import type { RawStatRow } from '@/lib/database/repositories/stats-repository';
import { streamToAsyncIterator, mergeAsyncIterables } from '@/lib/stream-utils';
import type Dockerode from 'dockerode';
import { BaseCollector } from './base-collector';

const DOCKER_SOURCE = 'docker';

function toRawStatRows(stat: ContainerStatsWithRates, hostName: string): RawStatRow[] {
  const timestamp = new Date();
  const entity = `${hostName}/${stat.id}`;

  return [
    { timestamp, source: DOCKER_SOURCE, type: 'cpu_percent', entity, value: stat.rates.cpuPercent },
    { timestamp, source: DOCKER_SOURCE, type: 'memory_usage', entity, value: stat.memory_stats?.usage || 0 },
    { timestamp, source: DOCKER_SOURCE, type: 'memory_limit', entity, value: stat.memory_stats?.limit || 0 },
    { timestamp, source: DOCKER_SOURCE, type: 'memory_percent', entity, value: stat.rates.memoryPercent },
    { timestamp, source: DOCKER_SOURCE, type: 'network_rx_bytes_per_sec', entity, value: stat.rates.networkRxBytesPerSec },
    { timestamp, source: DOCKER_SOURCE, type: 'network_tx_bytes_per_sec', entity, value: stat.rates.networkTxBytesPerSec },
    { timestamp, source: DOCKER_SOURCE, type: 'block_io_read_bytes_per_sec', entity, value: stat.rates.blockIoReadBytesPerSec },
    { timestamp, source: DOCKER_SOURCE, type: 'block_io_write_bytes_per_sec', entity, value: stat.rates.blockIoWriteBytesPerSec },
  ];
}

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

    try {
      for await (const stats of mergeAsyncIterables(containerStreams)) {
        if (this.signal.aborted) break;
        statsReceived++;
        const entity = `${this.hostConfig.name}/${stats.id}`;
        if (!this.shouldWrite(entity)) continue;
        statsWritten++;
        await this.addToBatch(toRawStatRows(stats, this.hostConfig.name));
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
