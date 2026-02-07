import { ChevronRight } from 'lucide-react';
import type { DockerStatsFromDB } from '@/types/docker';
import { formatAsPercent, formatBytes, formatBitsSIUnits } from '../../formatters/metrics';
import { MetricCell } from '../shared-table';
import { useSettings } from '@/hooks/useSettings';
import { useContainerChartData } from '@/hooks/useContainerChartData';
import ContainerChartsCard from './ContainerChartsCard';
import SparklineChart from './SparklineChart';

interface ContainerRowProps {
  container: DockerStatsFromDB;
  indent?: number;
}

export default function ContainerRow({ container, indent }: ContainerRowProps) {
  const { docker, toggleContainerExpanded, isContainerExpanded } = useSettings();
  const { rates } = container;
  const { decimals } = docker;
  const expanded = isContainerExpanded(container.id);

  const { dataPoints } = useContainerChartData({
    containerId: container.id,
    currentStats: rates,
    seconds: expanded ? 60 : 15,
  });

  // Extract sparkline data (last 15 points for compact display)
  const sparklinePoints = dataPoints.slice(-15);
  const cpuSparkline = sparklinePoints.map((d) => d.cpuPercent);
  const memorySparkline = sparklinePoints.map((d) => d.memoryPercent);
  const blockReadSparkline = sparklinePoints.map((d) => d.blockIoReadBytesPerSec);
  const blockWriteSparkline = sparklinePoints.map((d) => d.blockIoWriteBytesPerSec);
  const networkRxSparkline = sparklinePoints.map((d) => d.networkRxBytesPerSec);
  const networkTxSparkline = sparklinePoints.map((d) => d.networkTxBytesPerSec);

  // Block I/O is in bytes/sec
  const blockReadMBps = rates.blockIoReadBytesPerSec;
  const blockWriteMBps = rates.blockIoWriteBytesPerSec;

  // Network values are in bytes/sec, convert to bits/sec for display
  const networkRxBps = rates.networkRxBytesPerSec * 8;
  const networkTxBps = rates.networkTxBytesPerSec * 8;

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
        <MetricCell>
          <div className="flex items-center justify-end gap-2">
            <SparklineChart data={cpuSparkline} color="--chart-cpu" />
            <span className="min-w-[4rem] text-right">{formatAsPercent(rates.cpuPercent / 100, decimals.cpu)}</span>
          </div>
        </MetricCell>
        <MetricCell>
          <div className="flex items-center justify-end gap-2">
            <SparklineChart data={memorySparkline} color="--chart-memory" />
            <span className="min-w-[4rem] text-right">{memoryDisplay}</span>
          </div>
        </MetricCell>
        <MetricCell>
          <div className="flex items-center justify-end gap-2">
            <SparklineChart data={blockReadSparkline} color="--chart-read" />
            <span className="min-w-[5rem] text-right">{formatBytes(blockReadMBps, true, decimals.diskSpeed)}</span>
          </div>
        </MetricCell>
        <MetricCell>
          <div className="flex items-center justify-end gap-2">
            <SparklineChart data={blockWriteSparkline} color="--chart-write" />
            <span className="min-w-[5rem] text-right">{formatBytes(blockWriteMBps, true, decimals.diskSpeed)}</span>
          </div>
        </MetricCell>
        <MetricCell>
          <div className="flex items-center justify-end gap-2">
            <SparklineChart data={networkRxSparkline} color="--chart-read" />
            <span className="min-w-[5rem] text-right">{formatBitsSIUnits(networkRxBps, true, decimals.networkSpeed)}</span>
          </div>
        </MetricCell>
        <MetricCell>
          <div className="flex items-center justify-end gap-2">
            <SparklineChart data={networkTxSparkline} color="--chart-write" />
            <span className="min-w-[5rem] text-right">{formatBitsSIUnits(networkTxBps, true, decimals.networkSpeed)}</span>
          </div>
        </MetricCell>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} className="p-0">
            <ContainerChartsCard dataPoints={dataPoints} />
          </td>
        </tr>
      )}
    </>
  );
}
