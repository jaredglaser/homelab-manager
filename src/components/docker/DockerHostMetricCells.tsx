import type { HostAggregatedStats } from '@/types/docker';
import { formatAsPercent, formatBytes, formatBitsSIUnits } from '@/formatters/metrics';
import { MetricCell } from '../shared-table';
import { useSettings } from '@/hooks/useSettings';

interface DockerHostMetricCellsProps {
  aggregated: HostAggregatedStats;
}

export default function DockerHostMetricCells({ aggregated }: DockerHostMetricCellsProps) {
  const { docker } = useSettings();
  const { decimals } = docker;

  const memoryDisplay = docker.memoryDisplayMode === 'bytes'
    ? formatBytes(aggregated.memoryUsage, false, decimals.memory)
    : formatAsPercent(aggregated.memoryPercent / 100, decimals.memory);

  // Convert bytes/sec to bits/sec for network display
  const networkRxBps = aggregated.networkRxBytesPerSec * 8;
  const networkTxBps = aggregated.networkTxBytesPerSec * 8;

  return (
    <>
      <MetricCell>{formatAsPercent(aggregated.cpuPercent / 100, decimals.cpu)}</MetricCell>
      <MetricCell>{memoryDisplay}</MetricCell>
      <MetricCell>{formatBytes(aggregated.blockIoReadBytesPerSec, true, decimals.diskSpeed)}</MetricCell>
      <MetricCell>{formatBytes(aggregated.blockIoWriteBytesPerSec, true, decimals.diskSpeed)}</MetricCell>
      <MetricCell>{formatBitsSIUnits(networkRxBps, true, decimals.networkSpeed)}</MetricCell>
      <MetricCell>{formatBitsSIUnits(networkTxBps, true, decimals.networkSpeed)}</MetricCell>
    </>
  );
}
