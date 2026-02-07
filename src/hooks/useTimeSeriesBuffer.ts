import { useState, useCallback } from 'react';
import { useSSE } from './useSSE';
import type { ZFSIOStatWithRates } from '@/types/zfs';

const MAX_DATA_POINTS = 60;

export interface TimeSeriesDataPoint {
  timestamp: number;
  readBytesPerSec: number;
  writeBytesPerSec: number;
}

export interface PoolTimeSeriesData {
  poolName: string;
  dataPoints: TimeSeriesDataPoint[];
}

interface UseTimeSeriesBufferResult {
  poolsData: Map<string, PoolTimeSeriesData>;
  isConnected: boolean;
  error: Error | null;
}

export function useTimeSeriesBuffer(sseUrl: string): UseTimeSeriesBufferResult {
  const [poolsData, setPoolsData] = useState<Map<string, PoolTimeSeriesData>>(
    new Map()
  );

  const handleData = useCallback((data: ZFSIOStatWithRates[]) => {
    const now = Date.now();

    setPoolsData((prev) => {
      const next = new Map(prev);

      // Filter to only pool-level entities (indent === 0)
      const pools = data.filter((stat) => stat.indent === 0);

      for (const pool of pools) {
        const existing = next.get(pool.name) || {
          poolName: pool.name,
          dataPoints: [],
        };

        // Add new data point
        const newPoints = [
          ...existing.dataPoints,
          {
            timestamp: now,
            readBytesPerSec: pool.rates.readBytesPerSec,
            writeBytesPerSec: pool.rates.writeBytesPerSec,
          },
        ];

        // Keep only last MAX_DATA_POINTS
        if (newPoints.length > MAX_DATA_POINTS) {
          newPoints.shift();
        }

        next.set(pool.name, { poolName: pool.name, dataPoints: newPoints });
      }

      // Remove pools that no longer exist
      for (const poolName of next.keys()) {
        if (!pools.find((p) => p.name === poolName)) {
          next.delete(poolName);
        }
      }

      return next;
    });
  }, []);

  const { isConnected, error } = useSSE<ZFSIOStatWithRates[]>({
    url: sseUrl,
    onData: handleData,
  });

  return { poolsData, isConnected, error };
}
