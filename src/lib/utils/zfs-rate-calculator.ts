import type { RateCalculator } from '../streaming/types';
import type { ZFSIOStatRaw, ZFSIOStatWithRates } from '../../types/zfs';

interface PreviousZFSStats {
  stats: ZFSIOStatRaw;
  timestamp: number;
}

/**
 * Calculate rates for ZFS iostat data
 * Similar pattern to Docker's rate-calculator but for ZFS metrics
 *
 * Note: zpool iostat already provides per-second rates after the first output,
 * so we mainly track for consistency and add utilization percentage calculations
 */
export class ZFSRateCalculator implements RateCalculator<ZFSIOStatRaw, ZFSIOStatWithRates> {
  private cache = new Map<string, PreviousZFSStats>();

  calculate(id: string, current: ZFSIOStatRaw): ZFSIOStatWithRates {
    const now = Date.now();

    // Initialize with defaults (zpool iostat provides these directly)
    let rates = {
      readOpsPerSec: current.operations.read,
      writeOpsPerSec: current.operations.write,
      readBytesPerSec: current.bandwidth.read,
      writeBytesPerSec: current.bandwidth.write,
      utilizationPercent: 0,
    };

    // Calculate utilization percentage
    const totalCapacity = current.capacity.alloc + current.capacity.free;
    if (totalCapacity > 0) {
      rates.utilizationPercent = (current.capacity.alloc / totalCapacity) * 100;
    }

    // Update cache
    this.cache.set(id, {
      stats: current,
      timestamp: now,
    });

    return {
      ...current,
      id,
      timestamp: now,
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

/**
 * Convenience function to get rates for a single ZFS pool
 * Uses module-level rate calculator instance
 */
const defaultCalculator = new ZFSRateCalculator();

export function calculateZFSRates(
  poolName: string,
  stats: ZFSIOStatRaw
): ZFSIOStatWithRates {
  return defaultCalculator.calculate(poolName, stats);
}

export function clearZFSRatesCache(): void {
  defaultCalculator.clear();
}
