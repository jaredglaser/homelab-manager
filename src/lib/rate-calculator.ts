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
  private cache = new Map<string, PreviousStatsEntry>();

  calculate(id: string, current: DockerRateInput): ContainerStatsWithRates {
    const now = Date.now();
    const previous = this.cache.get(id);
    const currentStats = current.stats;

    let rates = {
      cpuPercent: 0,
      memoryPercent: 0,
      networkRxBytesPerSec: 0,
      networkTxBytesPerSec: 0,
      blockIoReadBytesPerSec: 0,
      blockIoWriteBytesPerSec: 0,
    };

    if (previous) {
      const timeDeltaMs = now - previous.timestamp;
      const timeDeltaSec = timeDeltaMs / 1000;

      if (timeDeltaSec > 0) {
        // CPU calculation (matching Docker CLI logic)
        const cpuDelta =
          currentStats.cpu_stats.cpu_usage.total_usage -
          previous.stats.cpu_stats.cpu_usage.total_usage;
        const systemDelta =
          currentStats.cpu_stats.system_cpu_usage -
          previous.stats.cpu_stats.system_cpu_usage;

        if (systemDelta > 0 && cpuDelta >= 0) {
          const cpuCount = currentStats.cpu_stats.online_cpus || 1;
          rates.cpuPercent = (cpuDelta / systemDelta) * cpuCount * 100;
        }

        // Network calculation
        if (currentStats.networks && previous.stats.networks) {
          let currentRxBytes = 0;
          let currentTxBytes = 0;
          let prevRxBytes = 0;
          let prevTxBytes = 0;

          for (const stats of Object.values(currentStats.networks)) {
            currentRxBytes += stats.rx_bytes || 0;
            currentTxBytes += stats.tx_bytes || 0;
          }

          for (const stats of Object.values(previous.stats.networks)) {
            prevRxBytes += stats.rx_bytes || 0;
            prevTxBytes += stats.tx_bytes || 0;
          }

          const rxDelta = currentRxBytes - prevRxBytes;
          const txDelta = currentTxBytes - prevTxBytes;

          if (rxDelta >= 0) {
            rates.networkRxBytesPerSec = rxDelta / timeDeltaSec;
          }
          if (txDelta >= 0) {
            rates.networkTxBytesPerSec = txDelta / timeDeltaSec;
          }
        }

        // Block IO calculation
        if (
          currentStats.blkio_stats?.io_service_bytes_recursive &&
          previous.stats.blkio_stats?.io_service_bytes_recursive
        ) {
          const currentRead =
            currentStats.blkio_stats.io_service_bytes_recursive.find(
              stat => stat.op === 'read' || stat.op === 'Read'
            )?.value || 0;

          const currentWrite =
            currentStats.blkio_stats.io_service_bytes_recursive.find(
              stat => stat.op === 'write' || stat.op === 'Write'
            )?.value || 0;

          const prevRead =
            previous.stats.blkio_stats.io_service_bytes_recursive.find(
              stat => stat.op === 'read' || stat.op === 'Read'
            )?.value || 0;

          const prevWrite =
            previous.stats.blkio_stats.io_service_bytes_recursive.find(
              stat => stat.op === 'write' || stat.op === 'Write'
            )?.value || 0;

          const readDelta = currentRead - prevRead;
          const writeDelta = currentWrite - prevWrite;

          if (readDelta >= 0) {
            rates.blockIoReadBytesPerSec = readDelta / timeDeltaSec;
          }
          if (writeDelta >= 0) {
            rates.blockIoWriteBytesPerSec = writeDelta / timeDeltaSec;
          }
        }
      }
    }

    // Memory percentage (doesn't require delta, always available)
    const memoryUsage = currentStats.memory_stats?.usage || 0;
    const memoryLimit = currentStats.memory_stats?.limit || 1;
    rates.memoryPercent = (memoryUsage / memoryLimit) * 100;

    // Update cache with current stats
    this.cache.set(id, {
      stats: currentStats,
      timestamp: now,
    });

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
