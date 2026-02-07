import { useState, useCallback, useEffect, useRef } from 'react';
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

export interface InitialPoolData {
  poolName: string;
  dataPoints: TimeSeriesDataPoint[];
}

interface UseTimeSeriesBufferOptions {
  sseUrl: string;
  fetchInitialData?: () => Promise<InitialPoolData[]>;
}

interface UseTimeSeriesBufferResult {
  poolsData: Map<string, PoolTimeSeriesData>;
  isConnected: boolean;
  error: Error | null;
}

export function useTimeSeriesBuffer(
  options: UseTimeSeriesBufferOptions | string
): UseTimeSeriesBufferResult {
  // Support both old string API and new options API
  const { sseUrl, fetchInitialData } =
    typeof options === 'string' ? { sseUrl: options, fetchInitialData: undefined } : options;

  const [poolsData, setPoolsData] = useState<Map<string, PoolTimeSeriesData>>(
    new Map()
  );
  const initialDataLoaded = useRef(false);

  // Load initial data on mount
  useEffect(() => {
    if (!fetchInitialData || initialDataLoaded.current) return;

    initialDataLoaded.current = true;

    fetchInitialData()
      .then((data) => {
        if (!data || data.length === 0) return;

        setPoolsData((prev) => {
          const next = new Map(prev);
          for (const pool of data) {
            const existing = next.get(pool.poolName);
            if (!existing || existing.dataPoints.length === 0) {
              // No existing data - use historical data directly
              next.set(pool.poolName, {
                poolName: pool.poolName,
                dataPoints: pool.dataPoints.slice(-MAX_DATA_POINTS),
              });
            } else {
              // SSE data already arrived - prepend historical data
              // Filter out historical points that overlap with existing data
              const oldestExisting = existing.dataPoints[0]?.timestamp ?? Infinity;
              const historicalPoints = pool.dataPoints.filter(
                (p) => p.timestamp < oldestExisting
              );
              if (historicalPoints.length > 0) {
                const merged = [...historicalPoints, ...existing.dataPoints];
                next.set(pool.poolName, {
                  poolName: pool.poolName,
                  dataPoints: merged.slice(-MAX_DATA_POINTS),
                });
              }
            }
          }
          return next;
        });
      })
      .catch((err) => {
        console.error('[useTimeSeriesBuffer] Failed to load initial data:', err);
      });
  }, [fetchInitialData]);

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
