import { useState, useEffect, useRef } from 'react';
import type { ContainerChartDataPoint } from '@/data/docker.functions';
import { getHistoricalDockerChartData } from '@/data/docker.functions';

const MAX_DATA_POINTS = 60;

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
}: UseContainerChartDataOptions): UseContainerChartDataResult {
  const [dataPoints, setDataPoints] = useState<ContainerChartDataPoint[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const initialDataLoaded = useRef(false);
  const lastTimestampRef = useRef<number>(0);

  // Load historical data on mount
  useEffect(() => {
    if (initialDataLoaded.current) return;
    initialDataLoaded.current = true;

    getHistoricalDockerChartData({ data: { containerId } })
      .then((data) => {
        if (data.length > 0) {
          setDataPoints(data.slice(-MAX_DATA_POINTS));
          lastTimestampRef.current = data[data.length - 1]?.timestamp ?? 0;
        }
        setIsLoading(false);
      })
      .catch((err) => {
        console.error('[useContainerChartData] Failed to load historical data:', err);
        setIsLoading(false);
      });
  }, [containerId]);

  // Append new data point when currentStats changes
  useEffect(() => {
    if (isLoading) return;

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
      if (next.length > MAX_DATA_POINTS) {
        next.shift();
      }
      return next;
    });
  }, [currentStats, isLoading]);

  return { dataPoints, isLoading };
}
