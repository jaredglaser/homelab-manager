export interface ContainerStatsInput {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
  };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
  blkio_stats?: {
    io_service_bytes_recursive?: Array<{ op?: string; value: number }>;
  };
}

export interface ContainerRates {
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRxBytesPerSec: number;
  networkTxBytesPerSec: number;
  blockReadBytesPerSec: number;
  blockWriteBytesPerSec: number;
}

interface PreviousStats {
  cpuTotal: number;
  systemCpu: number;
  rxBytes: number;
  txBytes: number;
  readBytes: number;
  writeBytes: number;
  timestamp: number;
}

export class RateCalculator {
  private previous = new Map<string, PreviousStats>();

  calculate(containerId: string, stats: ContainerStatsInput): ContainerRates | null {
    const now = Date.now();
    const cpuTotal = stats.cpu_stats?.cpu_usage?.total_usage ?? 0;
    const systemCpu = stats.cpu_stats?.system_cpu_usage ?? 0;
    const onlineCpus = stats.cpu_stats?.online_cpus ?? 1;
    const memUsage = stats.memory_stats?.usage ?? 0;
    const memLimit = stats.memory_stats?.limit ?? 1;

    let rxBytes = 0, txBytes = 0;
    if (stats.networks) {
      for (const net of Object.values(stats.networks)) {
        rxBytes += net.rx_bytes ?? 0;
        txBytes += net.tx_bytes ?? 0;
      }
    }

    let readBytes = 0, writeBytes = 0;
    for (const entry of stats.blkio_stats?.io_service_bytes_recursive ?? []) {
      const op = entry.op?.toLowerCase();
      if (op === 'read') readBytes += entry.value;
      if (op === 'write') writeBytes += entry.value;
    }

    const prev = this.previous.get(containerId);
    this.previous.set(containerId, { cpuTotal, systemCpu, rxBytes, txBytes, readBytes, writeBytes, timestamp: now });

    if (!prev) return null;
    const timeDeltaSec = (now - prev.timestamp) / 1000;
    if (timeDeltaSec <= 0) return null;

    const cpuDelta = Math.max(0, cpuTotal - prev.cpuTotal);
    const systemDelta = Math.max(0, systemCpu - prev.systemCpu);
    const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus * 100 : 0;

    return {
      cpuPercent,
      memoryUsage: memUsage,
      memoryLimit: memLimit,
      memoryPercent: memLimit > 0 ? (memUsage / memLimit) * 100 : 0,
      networkRxBytesPerSec: Math.max(0, (rxBytes - prev.rxBytes) / timeDeltaSec),
      networkTxBytesPerSec: Math.max(0, (txBytes - prev.txBytes) / timeDeltaSec),
      blockReadBytesPerSec: Math.max(0, (readBytes - prev.readBytes) / timeDeltaSec),
      blockWriteBytesPerSec: Math.max(0, (writeBytes - prev.writeBytes) / timeDeltaSec),
    };
  }

  remove(containerId: string): void {
    this.previous.delete(containerId);
  }

  pruneExcept(activeIds: Set<string>): void {
    for (const key of this.previous.keys()) {
      if (!activeIds.has(key)) this.previous.delete(key);
    }
  }

  clear(): void {
    this.previous.clear();
  }
}
