import { useMemo } from 'react';
import type { DockerStatsRow } from '@/types/docker';

/** A single time-series data point for a container's stats. */
export interface ChartDataPoint {
  timestamp: number;
  cpuPercent: number;
  memoryPercent: number;
  blockIoReadBytesPerSec: number;
  blockIoWriteBytesPerSec: number;
  networkRxBytesPerSec: number;
  networkTxBytesPerSec: number;
}

export interface SparklineData {
  cpu: { timestamp: number; value: number }[];
  memory: { timestamp: number; value: number }[];
  blockRead: { timestamp: number; value: number }[];
  blockWrite: { timestamp: number; value: number }[];
  networkRx: { timestamp: number; value: number }[];
  networkTx: { timestamp: number; value: number }[];
}

/** Transforms raw Docker stats rows into chart data points and sparkline arrays. */
export function buildContainerChartData(chartData: DockerStatsRow[]): {
  dataPoints: ChartDataPoint[];
  sparklineData: SparklineData;
} {
  const points: ChartDataPoint[] = new Array(chartData.length);
  const cpu: { timestamp: number; value: number }[] = new Array(chartData.length);
  const memory: { timestamp: number; value: number }[] = new Array(chartData.length);
  const blockRead: { timestamp: number; value: number }[] = new Array(chartData.length);
  const blockWrite: { timestamp: number; value: number }[] = new Array(chartData.length);
  const networkRx: { timestamp: number; value: number }[] = new Array(chartData.length);
  const networkTx: { timestamp: number; value: number }[] = new Array(chartData.length);

  for (let i = 0; i < chartData.length; i++) {
    const row = chartData[i];
    const timestamp = new Date(row.time).getTime();
    const cpuPercent = row.cpu_percent ?? 0;
    const memoryPercent = row.memory_percent ?? 0;
    const blockIoRead = row.block_io_read_bytes_per_sec ?? 0;
    const blockIoWrite = row.block_io_write_bytes_per_sec ?? 0;
    const netRx = row.network_rx_bytes_per_sec ?? 0;
    const netTx = row.network_tx_bytes_per_sec ?? 0;

    points[i] = { timestamp, cpuPercent, memoryPercent, blockIoReadBytesPerSec: blockIoRead, blockIoWriteBytesPerSec: blockIoWrite, networkRxBytesPerSec: netRx, networkTxBytesPerSec: netTx };
    cpu[i] = { timestamp, value: cpuPercent };
    memory[i] = { timestamp, value: memoryPercent };
    blockRead[i] = { timestamp, value: blockIoRead };
    blockWrite[i] = { timestamp, value: blockIoWrite };
    networkRx[i] = { timestamp, value: netRx };
    networkTx[i] = { timestamp, value: netTx };
  }

  return { dataPoints: points, sparklineData: { cpu, memory, blockRead, blockWrite, networkRx, networkTx } };
}

/**
 * Transforms raw Docker stats rows into typed data points and per-metric
 * sparkline arrays suitable for chart rendering.
 */
export function useContainerChartData(chartData: DockerStatsRow[]): {
  dataPoints: ChartDataPoint[];
  sparklineData: SparklineData;
} {
  return useMemo(() => buildContainerChartData(chartData), [chartData]);
}
