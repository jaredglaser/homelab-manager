import { useState, useEffect, useRef } from 'react';
import type { ContainerChartDataPoint } from '@/data/docker.functions';
import { getHistoricalDockerChartData } from '@/data/docker.functions';

interface UseContainerChartDataOptions {
  containerId: string;
  currentStats: {
    cpuPercent: number;
    memoryPercent: number;
    blockIoReadBytesPerSec: number;
    blockIoWriteBytesPerSec: number;
    networkRxBytesPerSec: number;
    networkTxBytesPerSec: number;
  };
  /** Number of seconds of historical data to fetch and maintain. Default: 15 */
  seconds?: number;
  /** Whether to fetch and accumulate data. Default: true */
  enabled?: boolean;
}

interface UseContainerChartDataResult {
  dataPoints: ContainerChartDataPoint[];
  isLoading: boolean;
}

/**
 * Hook to manage chart data buffer for a single container.
 * Fetches historical data on mount and appends real-time updates.
 */
export function useContainerChartData({
  containerId,
  currentStats,
  seconds = 15,
  enabled = true,
}: UseContainerChartDataOptions): UseContainerChartDataResult {
  const [dataPoints, setDataPoints] = useState<ContainerChartDataPoint[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const secondsFetchedRef = useRef(0);
  const lastTimestampRef = useRef<number>(0);

  // Load historical data on mount or when seconds increases
  useEffect(() => {
    if (!enabled) return;
    // Only fetch if we need more data than we've already fetched
    if (seconds <= secondsFetchedRef.current) return;

    setIsLoading(true);
    getHistoricalDockerChartData({ data: { containerId, seconds } })
      .then((data) => {
        secondsFetchedRef.current = seconds;
        if (data.length > 0) {
          setDataPoints((prev) => {
            // Merge historical data with any accumulated points
            const historicalTimestamps = new Set(data.map((d) => d.timestamp));
            const newPoints = prev.filter((p) => !historicalTimestamps.has(p.timestamp));
            const merged = [...data, ...newPoints].slice(-seconds);
            lastTimestampRef.current = merged[merged.length - 1]?.timestamp ?? 0;
            return merged;
          });
        }
        setIsLoading(false);
      })
      .catch((err) => {
        console.error('[useContainerChartData] Failed to load historical data:', err);
        setIsLoading(false);
      });
  }, [containerId, seconds, enabled]);

  // Append new data point when currentStats changes
  useEffect(() => {
    if (!enabled || isLoading) return;

    const now = Date.now();
    // Debounce: only add new point if at least 500ms has passed
    if (now - lastTimestampRef.current < 500) return;

    lastTimestampRef.current = now;

    const newPoint: ContainerChartDataPoint = {
      timestamp: now,
      cpuPercent: currentStats.cpuPercent,
      memoryPercent: currentStats.memoryPercent,
      blockIoReadBytesPerSec: currentStats.blockIoReadBytesPerSec,
      blockIoWriteBytesPerSec: currentStats.blockIoWriteBytesPerSec,
      networkRxBytesPerSec: currentStats.networkRxBytesPerSec,
      networkTxBytesPerSec: currentStats.networkTxBytesPerSec,
    };

    setDataPoints((prev) => {
      const next = [...prev, newPoint];
      if (next.length > seconds) {
        next.shift();
      }
      return next;
    });
  }, [currentStats, isLoading, seconds, enabled]);

  return { dataPoints, isLoading };
}
