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
    const dockerClient = await dockerConnectionManager.getClient({
      host: this.hostConfig.host,
      port: this.hostConfig.port,
      protocol: this.hostConfig.protocol,
    });

    const docker = dockerClient.getDocker();
    const containers = await docker.listContainers({ all: false });

    if (containers.length === 0) {
      console.log(`[${this.name}] No running containers found, waiting...`);
      return; // Base class handles the reconnect delay
    }

    // Upsert container metadata for display purposes
    for (const containerInfo of containers) {
      const containerName = containerInfo.Names[0]?.replace(/^\//, '') || containerInfo.Id.substring(0, 12);
      const entityPath = `${this.hostConfig.name}/${containerInfo.Id}`;
      await this.repository.upsertEntityMetadata(
        DOCKER_SOURCE,
        entityPath,
        'name',
        containerName
      );
      // Also store the image name for icon resolution
      await this.repository.upsertEntityMetadata(
        DOCKER_SOURCE,
        entityPath,
        'image',
        containerInfo.Image
      );
    }

    console.log(`[${this.name}] Monitoring ${containers.length} containers`);
    this.resetBackoff();

    const streams: any[] = [];
    const containerStreams = containers.map(info => this.streamContainerStats(docker, info, streams));

    try {
      for await (const stats of mergeAsyncIterables(containerStreams)) {
        if (this.signal.aborted) break;
        await this.addToBatch(toRawStatRows(stats, this.hostConfig.name));
      }
    } finally {
      streams.forEach(stream => {
        if (stream && typeof stream.destroy === 'function') {
          stream.destroy();
        }
      });
    }
  }

  private async *streamContainerStats(
    docker: Dockerode,
    containerInfo: Dockerode.ContainerInfo,
    streams: any[],
  ): AsyncGenerator<ContainerStatsWithRates> {
    const containerName = containerInfo.Names[0]?.replace(/^\//, '') || containerInfo.Id.substring(0, 12);

    try {
      const container = docker.getContainer(containerInfo.Id);
      const statsStream = await container.stats({ stream: true });
      streams.push(statsStream);

      for await (const stats of streamToAsyncIterator<Dockerode.ContainerStats>(statsStream)) {
        if (this.signal.aborted) break;

        yield this.calculator.calculate(containerInfo.Id, {
          containerId: containerInfo.Id,
          containerName,
          stats,
        });
      }
    } catch (err) {
      console.error(`[${this.name}] Error streaming stats for ${containerName}:`, err);
    }
  }
}
