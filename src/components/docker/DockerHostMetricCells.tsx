import type { HostAggregatedStats } from '@/types/docker';
import { formatAsPercent, formatBytes, formatBitsSIUnits } from '@/formatters/metrics';
import { MetricCell } from '../shared-table';
import { useSettings } from '@/hooks/useSettings';

interface DockerHostMetricCellsProps {
  aggregated: HostAggregatedStats;
}

export default function DockerHostMetricCells({ aggregated }: DockerHostMetricCellsProps) {
  const { docker } = useSettings();

  const memoryDisplay = docker.memoryDisplayMode === 'bytes'
    ? formatBytes(aggregated.memoryUsage, false)
    : formatAsPercent(aggregated.memoryPercent / 100);

  // Convert bytes/sec to bits/sec for network display
  const networkRxBps = aggregated.networkRxBytesPerSec * 8;
  const networkTxBps = aggregated.networkTxBytesPerSec * 8;

  return (
    <>
      <MetricCell>{formatAsPercent(aggregated.cpuPercent / 100)}</MetricCell>
      <MetricCell>{memoryDisplay}</MetricCell>
      <MetricCell>{formatBytes(aggregated.blockIoReadBytesPerSec, true)}</MetricCell>
      <MetricCell>{formatBytes(aggregated.blockIoWriteBytesPerSec, true)}</MetricCell>
      <MetricCell>{formatBitsSIUnits(networkRxBps * 8, true)}</MetricCell>
      <MetricCell>{formatBitsSIUnits(networkTxBps * 8, true)}</MetricCell>
    </>
  );
}
