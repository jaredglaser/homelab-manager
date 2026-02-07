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
  const lastValuesRef = useRef<string>('');

  // Load historical data on mount
  useEffect(() => {
    if (initialDataLoaded.current) return;
    initialDataLoaded.current = true;

    getHistoricalDockerChartData({ data: { containerId } })
      .then((data) => {
        if (data.length > 0) {
          setDataPoints(data.slice(-MAX_DATA_POINTS));
        }
        setIsLoading(false);
      })
      .catch((err) => {
        console.error('[useContainerChartData] Failed to load historical data:', err);
        setIsLoading(false);
      });
  }, [containerId]);

  // Create a stable key from stats values to detect real changes
  const statsKey = `${currentStats.cpuPercent.toFixed(2)}-${currentStats.memoryPercent.toFixed(2)}-${currentStats.blockIoReadBytesPerSec.toFixed(0)}-${currentStats.blockIoWriteBytesPerSec.toFixed(0)}-${currentStats.networkRxBytesPerSec.toFixed(0)}-${currentStats.networkTxBytesPerSec.toFixed(0)}`;

  // Append new data point when stats actually change
  useEffect(() => {
    if (isLoading) return;
    if (statsKey === lastValuesRef.current) return;

    lastValuesRef.current = statsKey;
    const now = Date.now();

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
  }, [statsKey, currentStats, isLoading]);

  return { dataPoints, isLoading };
}
