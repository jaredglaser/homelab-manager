import type { HostAggregatedStats } from '@/types/docker';
import { formatAsPercentParts, formatBytesParts, formatBitsSIUnitsParts } from '@/formatters/metrics';
import { MetricCell } from '../shared-table';
import { useSettings } from '@/hooks/useSettings';

interface DockerHostMetricCellsProps {
  aggregated: HostAggregatedStats;
}

export default function DockerHostMetricCells({ aggregated }: DockerHostMetricCellsProps) {
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
        <div className="flex items-center justify-end gap-2">
          <span className="min-w-[3.5rem] text-right tabular-nums">{cpuParts.value}</span>
          <span className="w-[3rem] text-left">{cpuParts.unit}</span>
        </div>
      </MetricCell>
      <MetricCell>
        <div className="flex items-center justify-end gap-2">
          <span className="min-w-[3.5rem] text-right tabular-nums">{memoryParts.value}</span>
          <span className="w-[3rem] text-left">{memoryParts.unit}</span>
        </div>
      </MetricCell>
      <MetricCell>
        <div className="flex items-center justify-end gap-2">
          <span className="min-w-[3.5rem] text-right tabular-nums">{blockReadParts.value}</span>
          <span className="w-[3rem] text-left">{blockReadParts.unit}</span>
        </div>
      </MetricCell>
      <MetricCell>
        <div className="flex items-center justify-end gap-2">
          <span className="min-w-[3.5rem] text-right tabular-nums">{blockWriteParts.value}</span>
          <span className="w-[3rem] text-left">{blockWriteParts.unit}</span>
        </div>
      </MetricCell>
      <MetricCell>
        <div className="flex items-center justify-end gap-2">
          <span className="min-w-[3.5rem] text-right tabular-nums">{networkRxParts.value}</span>
          <span className="w-[3rem] text-left">{networkRxParts.unit}</span>
        </div>
      </MetricCell>
      <MetricCell>
        <div className="flex items-center justify-end gap-2">
          <span className="min-w-[3.5rem] text-right tabular-nums">{networkTxParts.value}</span>
          <span className="w-[3rem] text-left">{networkTxParts.unit}</span>
        </div>
      </MetricCell>
    </>
  );
}
