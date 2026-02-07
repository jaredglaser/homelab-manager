import { ChevronRight } from 'lucide-react';
import type { DockerStatsFromDB } from '@/types/docker';
import { formatAsPercent, formatBytes, formatBitsSIUnits } from '../../formatters/metrics';
import { MetricCell } from '../shared-table';
import { useSettings } from '@/hooks/useSettings';
import ContainerChartsCard from './ContainerChartsCard';

interface ContainerRowProps {
  container: DockerStatsFromDB;
  indent?: number;
}

export default function ContainerRow({ container, indent }: ContainerRowProps) {
  const { docker, toggleContainerExpanded, isContainerExpanded } = useSettings();
  const { rates } = container;
  const { decimals } = docker;
  const expanded = isContainerExpanded(container.id);

  // Convert bytes/sec to MB/s (using binary: 1 MB = 1024 * 1024 bytes)
  const blockReadMBps = rates.blockIoReadBytesPerSec;
  const blockWriteMBps = rates.blockIoWriteBytesPerSec;

  // Convert bytes/sec to Mbps (using decimal: 1 Mbps = 1,000,000 bits/sec)
  const networkRxBps = (rates.networkRxBytesPerSec * 8);
  const networkTxBps = (rates.networkTxBytesPerSec * 8);

  const memoryDisplay = docker.memoryDisplayMode === 'bytes'
    ? formatBytes(container.memory_stats.usage, false, decimals.memory)
    : formatAsPercent(rates.memoryPercent / 100, decimals.memory);

  const handleClick = () => {
    toggleContainerExpanded(container.id);
  };

  return (
    <>
      <tr
        onClick={handleClick}
        className="cursor-pointer transition-all duration-200 hover:bg-blue-500/5 hover:shadow-[inset_0_0_0_1px_rgba(59,130,246,0.3)]"
      >
        <td className={indent ? 'pl-8' : undefined}>
          <div className="flex items-center gap-2">
            <ChevronRight
              size={16}
              className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
            />
            {container.name}
          </div>
        </td>
        <MetricCell>{formatAsPercent(rates.cpuPercent / 100, decimals.cpu)}</MetricCell>
        <MetricCell>{memoryDisplay}</MetricCell>
        <MetricCell>{formatBytes(blockReadMBps, true, decimals.diskSpeed)}</MetricCell>
        <MetricCell>{formatBytes(blockWriteMBps, true, decimals.diskSpeed)}</MetricCell>
        <MetricCell>{formatBitsSIUnits(networkRxBps * 8, true, decimals.networkSpeed)}</MetricCell>
        <MetricCell>{formatBitsSIUnits(networkTxBps * 8, true, decimals.networkSpeed)}</MetricCell>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} className="p-0">
            <ContainerChartsCard
              containerId={container.id}
              containerStats={container}
            />
          </td>
        </tr>
      )}
    </>
  );
}
