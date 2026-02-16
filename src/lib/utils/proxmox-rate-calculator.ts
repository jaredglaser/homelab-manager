import type { RateCalculator } from '@/lib/streaming/types';
import type { ProxmoxRateInput, ProxmoxStatsWithRates } from '@/types/proxmox';

interface PreviousProxmoxStats {
  netin: number;
  netout: number;
  diskread: number;
  diskwrite: number;
  timestamp: number;
}

/**
 * Rate calculator for Proxmox stats.
 * Computes per-second rates for network and disk I/O from cumulative counters.
 * CPU and memory percentages are computed directly (no delta needed).
 */
export class ProxmoxRateCalculator implements RateCalculator<ProxmoxRateInput, ProxmoxStatsWithRates> {
  private cache = new Map<string, PreviousProxmoxStats>();

  calculate(id: string, current: ProxmoxRateInput): ProxmoxStatsWithRates {
    const now = Date.now();
    const prev = this.cache.get(id);

    let networkInPerSec = 0;
    let networkOutPerSec = 0;
    let diskReadPerSec = 0;
    let diskWritePerSec = 0;

    if (prev) {
      const deltaMs = now - prev.timestamp;
      const deltaSec = deltaMs / 1000;

      if (deltaSec > 0) {
        const netinDelta = current.netin - prev.netin;
        const netoutDelta = current.netout - prev.netout;
        const diskreadDelta = current.diskread - prev.diskread;
        const diskwriteDelta = current.diskwrite - prev.diskwrite;

        if (netinDelta >= 0) networkInPerSec = netinDelta / deltaSec;
        if (netoutDelta >= 0) networkOutPerSec = netoutDelta / deltaSec;
        if (diskreadDelta >= 0) diskReadPerSec = diskreadDelta / deltaSec;
        if (diskwriteDelta >= 0) diskWritePerSec = diskwriteDelta / deltaSec;
      }
    }

    this.cache.set(id, {
      netin: current.netin,
      netout: current.netout,
      diskread: current.diskread,
      diskwrite: current.diskwrite,
      timestamp: now,
    });

    const cpuPercent = current.cpu * 100;
    const memoryPercent = current.maxmem > 0 ? (current.mem / current.maxmem) * 100 : 0;

    return {
      ...current,
      rates: {
        cpuPercent,
        memoryPercent,
        networkInBytesPerSec: networkInPerSec,
        networkOutBytesPerSec: networkOutPerSec,
        diskReadBytesPerSec: diskReadPerSec,
        diskWriteBytesPerSec: diskWritePerSec,
      },
    };
  }

  clear(): void {
    this.cache.clear();
  }

  remove(id: string): void {
    this.cache.delete(id);
  }
}
