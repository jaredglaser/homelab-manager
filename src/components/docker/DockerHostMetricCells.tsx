import { memo } from 'react';
import type { HostAggregatedStats } from '@/types/docker';
import { formatAsPercentParts, formatBytesParts, formatBitsSIUnitsParts } from '@/formatters/metrics';
import { MetricCell, MetricValue } from '../shared-table';
import { useSettings } from '@/hooks/useSettings';

interface DockerHostMetricCellsProps {
  aggregated: HostAggregatedStats;
}

export default memo(function DockerHostMetricCells({ aggregated }: DockerHostMetricCellsProps) {
  const { docker } = useSettings();
  const { decimals } = docker;

  // Convert bytes/sec to bits/sec for network display
  const networkRxBps = aggregated.networkRxBytesPerSec * 8;
  const networkTxBps = aggregated.networkTxBytesPerSec * 8;

  // Format all metrics as parts for proper alignment
  const cpuParts = formatAsPercentParts(aggregated.cpuPercent / 100, decimals.cpu);
  const memoryParts = docker.memoryDisplayMode === 'bytes'
    ? formatBytesParts(aggregated.memoryUsage, false, decimals.memory)
    : formatAsPercentParts(aggregated.memoryPercent / 100, decimals.memory);
  const blockReadParts = formatBytesParts(aggregated.blockIoReadBytesPerSec, true, decimals.diskSpeed);
  const blockWriteParts = formatBytesParts(aggregated.blockIoWriteBytesPerSec, true, decimals.diskSpeed);
  const networkRxParts = formatBitsSIUnitsParts(networkRxBps, true, decimals.networkSpeed);
  const networkTxParts = formatBitsSIUnitsParts(networkTxBps, true, decimals.networkSpeed);

  return (
    <>
      <MetricCell>
        <MetricValue value={cpuParts.value} unit={cpuParts.unit} hasDecimals={decimals.cpu} />
      </MetricCell>
      <MetricCell>
        <MetricValue value={memoryParts.value} unit={memoryParts.unit} hasDecimals={decimals.memory} />
      </MetricCell>
      <MetricCell>
        <MetricValue value={blockReadParts.value} unit={blockReadParts.unit} hasDecimals={decimals.diskSpeed} />
      </MetricCell>
      <MetricCell>
        <MetricValue value={blockWriteParts.value} unit={blockWriteParts.unit} hasDecimals={decimals.diskSpeed} />
      </MetricCell>
      <MetricCell>
        <MetricValue value={networkRxParts.value} unit={networkRxParts.unit} hasDecimals={decimals.networkSpeed} />
      </MetricCell>
      <MetricCell>
        <MetricValue value={networkTxParts.value} unit={networkTxParts.unit} hasDecimals={decimals.networkSpeed} />
      </MetricCell>
    </>
  );
});
