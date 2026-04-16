import type Dockerode from 'dockerode';
import type { RateCalculator } from './streaming/types';

export interface ContainerStatsWithRates extends Dockerode.ContainerStats {
  id: string;
  name: string;
  rates: {
    cpuPercent: number;
    memoryPercent: number;
    networkRxBytesPerSec: number;
    networkTxBytesPerSec: number;
    blockIoReadBytesPerSec: number;
    blockIoWriteBytesPerSec: number;
  };
}

interface PreviousStatsEntry {
  stats: Dockerode.ContainerStats;
  timestamp: number;
}

interface DockerRateInput {
  containerId: string;
  containerName: string;
  stats: Dockerode.ContainerStats;
}

export class DockerRateCalculator implements RateCalculator<DockerRateInput, ContainerStatsWithRates> {
  private readonly cache = new Map<string, PreviousStatsEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  calculate(id: string, current: DockerRateInput): ContainerStatsWithRates {
    const now = this.now();
    const previous = this.cache.get(id);
    const currentStats = current.stats;
    const timeDeltaSec = previous ? (now - previous.timestamp) / 1000 : 0;
    const hasDelta = previous !== undefined && timeDeltaSec > 0;

    const rates = {
      cpuPercent: hasDelta ? computeCpuPercent(previous.stats, currentStats) : 0,
      memoryPercent: computeMemoryPercent(currentStats),
      ...(hasDelta
        ? computeNetworkRates(previous.stats, currentStats, timeDeltaSec)
        : { networkRxBytesPerSec: 0, networkTxBytesPerSec: 0 }),
      ...(hasDelta
        ? computeBlockIoRates(previous.stats, currentStats, timeDeltaSec)
        : { blockIoReadBytesPerSec: 0, blockIoWriteBytesPerSec: 0 }),
    };

    this.cache.set(id, { stats: currentStats, timestamp: now });

    return {
      ...currentStats,
      id: current.containerId,
      name: current.containerName,
      rates,
    };
  }

  clear(): void {
    this.cache.clear();
  }

  remove(id: string): void {
    this.cache.delete(id);
  }
}

// Matches Docker CLI logic.
function computeCpuPercent(prev: Dockerode.ContainerStats, curr: Dockerode.ContainerStats): number {
  const cpuDelta = curr.cpu_stats.cpu_usage.total_usage - prev.cpu_stats.cpu_usage.total_usage;
  const systemDelta = curr.cpu_stats.system_cpu_usage - prev.cpu_stats.system_cpu_usage;
  if (systemDelta <= 0 || cpuDelta < 0) return 0;
  const cpuCount = curr.cpu_stats.online_cpus || 1;
  return (cpuDelta / systemDelta) * cpuCount * 100;
}

function computeMemoryPercent(curr: Dockerode.ContainerStats): number {
  const usage = curr.memory_stats?.usage || 0;
  const limit = curr.memory_stats?.limit || 1;
  return (usage / limit) * 100;
}

function sumNetworkBytes(stats: Dockerode.ContainerStats): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  if (!stats.networks) return { rx, tx };
  for (const iface of Object.values(stats.networks)) {
    rx += iface.rx_bytes || 0;
    tx += iface.tx_bytes || 0;
  }
  return { rx, tx };
}

function computeNetworkRates(
  prev: Dockerode.ContainerStats,
  curr: Dockerode.ContainerStats,
  timeDeltaSec: number,
): { networkRxBytesPerSec: number; networkTxBytesPerSec: number } {
  if (!curr.networks || !prev.networks) {
    return { networkRxBytesPerSec: 0, networkTxBytesPerSec: 0 };
  }
  const currentBytes = sumNetworkBytes(curr);
  const prevBytes = sumNetworkBytes(prev);
  const rxDelta = currentBytes.rx - prevBytes.rx;
  const txDelta = currentBytes.tx - prevBytes.tx;
  return {
    networkRxBytesPerSec: rxDelta >= 0 ? rxDelta / timeDeltaSec : 0,
    networkTxBytesPerSec: txDelta >= 0 ? txDelta / timeDeltaSec : 0,
  };
}

function findBlkioBytes(stats: Dockerode.ContainerStats, op: 'read' | 'write'): number {
  const entries = stats.blkio_stats?.io_service_bytes_recursive;
  if (!entries) return 0;
  const lower = op;
  const upper = op === 'read' ? 'Read' : 'Write';
  return entries.find((stat) => stat.op === lower || stat.op === upper)?.value || 0;
}

function computeBlockIoRates(
  prev: Dockerode.ContainerStats,
  curr: Dockerode.ContainerStats,
  timeDeltaSec: number,
): { blockIoReadBytesPerSec: number; blockIoWriteBytesPerSec: number } {
  if (!curr.blkio_stats?.io_service_bytes_recursive || !prev.blkio_stats?.io_service_bytes_recursive) {
    return { blockIoReadBytesPerSec: 0, blockIoWriteBytesPerSec: 0 };
  }
  const readDelta = findBlkioBytes(curr, 'read') - findBlkioBytes(prev, 'read');
  const writeDelta = findBlkioBytes(curr, 'write') - findBlkioBytes(prev, 'write');
  return {
    blockIoReadBytesPerSec: readDelta >= 0 ? readDelta / timeDeltaSec : 0,
    blockIoWriteBytesPerSec: writeDelta >= 0 ? writeDelta / timeDeltaSec : 0,
  };
}
