import { useMemo } from 'react';
import type { DockerStatsRow } from '@/types/docker';
import type { SparklinePoint } from '@/components/ui/datatable/sparkline-accumulator-store';

export type { SparklinePoint };

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
  cpu: SparklinePoint[];
  memory: SparklinePoint[];
  blockRead: SparklinePoint[];
  blockWrite: SparklinePoint[];
  networkRx: SparklinePoint[];
  networkTx: SparklinePoint[];
}

/** Transforms raw Docker stats rows into chart data points and sparkline arrays. */
export function buildContainerChartData(chartData: DockerStatsRow[]): {
  dataPoints: ChartDataPoint[];
  sparklineData: SparklineData;
} {
  const points: ChartDataPoint[] = [];
  const cpu: SparklinePoint[] = [];
  const memory: SparklinePoint[] = [];
  const blockRead: SparklinePoint[] = [];
  const blockWrite: SparklinePoint[] = [];
  const networkRx: SparklinePoint[] = [];
  const networkTx: SparklinePoint[] = [];

  for (let i = 0; i < chartData.length; i++) {
    const row = chartData[i];
    const timestamp = new Date(row.time).getTime();
    const cpuPercent = row.cpu_percent ?? 0;
    const memoryPercent = row.memory_percent ?? 0;
    const blockIoRead = row.block_io_read_bytes_per_sec ?? 0;
    const blockIoWrite = row.block_io_write_bytes_per_sec ?? 0;
    const netRx = row.network_rx_bytes_per_sec ?? 0;
    const netTx = row.network_tx_bytes_per_sec ?? 0;

    points.push({ timestamp, cpuPercent, memoryPercent, blockIoReadBytesPerSec: blockIoRead, blockIoWriteBytesPerSec: blockIoWrite, networkRxBytesPerSec: netRx, networkTxBytesPerSec: netTx });
    cpu.push({ timestamp, value: cpuPercent });
    memory.push({ timestamp, value: memoryPercent });
    blockRead.push({ timestamp, value: blockIoRead });
    blockWrite.push({ timestamp, value: blockIoWrite });
    networkRx.push({ timestamp, value: netRx });
    networkTx.push({ timestamp, value: netTx });
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
