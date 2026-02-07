import { ChevronRight } from 'lucide-react';
import type { DockerStatsFromDB } from '@/types/docker';
import { formatAsPercentParts, formatBytesParts, formatBitsSIUnitsParts } from '../../formatters/metrics';
import { MetricCell, MetricValue } from '../shared-table';
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
  const { decimals, showSparklines } = docker;
  const expanded = isContainerExpanded(container.id);

  // Only fetch chart data if sparklines are enabled or row is expanded
  const needsChartData = showSparklines || expanded;
  const { dataPoints } = useContainerChartData({
    containerId: container.id,
    currentStats: rates,
    seconds: expanded ? 60 : 15,
    enabled: needsChartData,
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

  // Format all metrics as parts for proper alignment
  const cpuParts = formatAsPercentParts(rates.cpuPercent / 100, decimals.cpu);
  const memoryParts = docker.memoryDisplayMode === 'bytes'
    ? formatBytesParts(container.memory_stats.usage, false, decimals.memory)
    : formatAsPercentParts(rates.memoryPercent / 100, decimals.memory);
  const blockReadParts = formatBytesParts(blockReadMBps, true, decimals.diskSpeed);
  const blockWriteParts = formatBytesParts(blockWriteMBps, true, decimals.diskSpeed);
  const networkRxParts = formatBitsSIUnitsParts(networkRxBps, true, decimals.networkSpeed);
  const networkTxParts = formatBitsSIUnitsParts(networkTxBps, true, decimals.networkSpeed);

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
          <MetricValue
            value={cpuParts.value}
            unit={cpuParts.unit}
            hasDecimals={decimals.cpu}
            sparkline={showSparklines && <SparklineChart data={cpuSparkline} color="--chart-cpu" className="hidden lg:block" />}
          />
        </MetricCell>
        <MetricCell>
          <MetricValue
            value={memoryParts.value}
            unit={memoryParts.unit}
            hasDecimals={decimals.memory}
            sparkline={showSparklines && <SparklineChart data={memorySparkline} color="--chart-memory" className="hidden lg:block" />}
          />
        </MetricCell>
        <MetricCell>
          <MetricValue
            value={blockReadParts.value}
            unit={blockReadParts.unit}
            hasDecimals={decimals.diskSpeed}
            sparkline={showSparklines && <SparklineChart data={blockReadSparkline} color="--chart-read" className="hidden lg:block" />}
          />
        </MetricCell>
        <MetricCell>
          <MetricValue
            value={blockWriteParts.value}
            unit={blockWriteParts.unit}
            hasDecimals={decimals.diskSpeed}
            sparkline={showSparklines && <SparklineChart data={blockWriteSparkline} color="--chart-write" className="hidden lg:block" />}
          />
        </MetricCell>
        <MetricCell>
          <MetricValue
            value={networkRxParts.value}
            unit={networkRxParts.unit}
            hasDecimals={decimals.networkSpeed}
            sparkline={showSparklines && <SparklineChart data={networkRxSparkline} color="--chart-read" className="hidden lg:block" />}
          />
        </MetricCell>
        <MetricCell>
          <MetricValue
            value={networkTxParts.value}
            unit={networkTxParts.unit}
            hasDecimals={decimals.networkSpeed}
            sparkline={showSparklines && <SparklineChart data={networkTxSparkline} color="--chart-write" className="hidden lg:block" />}
          />
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
