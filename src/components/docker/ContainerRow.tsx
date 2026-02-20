import { memo, useMemo, useState, useEffect } from 'react';
import { ChevronRight, Settings } from 'lucide-react';
import Tooltip from '@mui/joy/Tooltip';
import type { DockerStatsFromDB, DockerStatsRow } from '@/types/docker';
import { formatAsPercentParts, formatBytesParts, formatBitsSIUnitsParts } from '../../formatters/metrics';
import { MetricValue } from '../shared-table';
import { useSettings } from '@/hooks/useSettings';
import ContainerChartsCard from './ContainerChartsCard';
import SparklineChart from './SparklineChart';
import IconPickerDialog from './IconPickerDialog';
import { getIconUrl, FALLBACK_ICON_URL } from '@/lib/utils/icon-resolver';
import { updateContainerIcon } from '@/data/docker.functions';
import { DOCKER_GRID } from './ContainerTable';

/** Chart data point derived from wide rows */
interface ChartDataPoint {
  timestamp: number;
  cpuPercent: number;
  memoryPercent: number;
  blockIoReadBytesPerSec: number;
  blockIoWriteBytesPerSec: number;
  networkRxBytesPerSec: number;
  networkTxBytesPerSec: number;
}

interface ContainerRowProps {
  container: DockerStatsFromDB;
  chartData: DockerStatsRow[];
}

export default memo(function ContainerRow({ container, chartData }: ContainerRowProps) {
  const { docker, toggleContainerExpanded, isContainerExpanded } = useSettings();
  const { rates } = container;
  const { decimals, showSparklines } = docker;
  const expanded = isContainerExpanded(container.id);

  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [iconError, setIconError] = useState(false);
  const [isPulsing, setIsPulsing] = useState(false);

  const iconUrl = getIconUrl(container.icon, container.image);

  const handleIconSelect = async (iconSlug: string) => {
    await updateContainerIcon({ data: { entityId: container.id, iconSlug } });
  };

  // Get last update timestamp from most recent chart data
  const lastUpdated = chartData.length > 0 ? new Date(chartData[chartData.length - 1].time) : undefined;
  const lastUpdatedRef = useMemo(() => ({ current: lastUpdated }), []);

  // Detect when container stats update and trigger pulse animation
  useEffect(() => {
    if (lastUpdated && lastUpdatedRef.current !== lastUpdated) {
      lastUpdatedRef.current = lastUpdated;
      setIsPulsing(true);
      const timer = setTimeout(() => setIsPulsing(false), 1000);
      return () => clearTimeout(timer);
    }
  }, [lastUpdated, lastUpdatedRef]);

  // Convert wide rows to chart data points
  const dataPoints = useMemo<ChartDataPoint[]>(() => {
    return chartData.map((row) => ({
      timestamp: new Date(row.time).getTime(),
      cpuPercent: row.cpu_percent ?? 0,
      memoryPercent: row.memory_percent ?? 0,
      blockIoReadBytesPerSec: row.block_io_read_bytes_per_sec ?? 0,
      blockIoWriteBytesPerSec: row.block_io_write_bytes_per_sec ?? 0,
      networkRxBytesPerSec: row.network_rx_bytes_per_sec ?? 0,
      networkTxBytesPerSec: row.network_tx_bytes_per_sec ?? 0,
    }));
  }, [chartData]);

  // Memoize sparkline arrays to avoid recreating on every render
  // Keep last 30 seconds of data for time-based sparklines
  // Use the latest data point's timestamp as the reference, not Date.now()
  const sparklines = useMemo(() => {
    if (dataPoints.length === 0) {
      return {
        cpu: [],
        memory: [],
        blockRead: [],
        blockWrite: [],
        networkRx: [],
        networkTx: [],
      };
    }

    const latestTimestamp = dataPoints[dataPoints.length - 1].timestamp;
    const thirtySecondsAgo = latestTimestamp - 30000;
    const points = dataPoints.filter((d) => d.timestamp >= thirtySecondsAgo);

    return {
      cpu: points.map((d) => ({ timestamp: d.timestamp, value: d.cpuPercent })),
      memory: points.map((d) => ({ timestamp: d.timestamp, value: d.memoryPercent })),
      blockRead: points.map((d) => ({ timestamp: d.timestamp, value: d.blockIoReadBytesPerSec })),
      blockWrite: points.map((d) => ({ timestamp: d.timestamp, value: d.blockIoWriteBytesPerSec })),
      networkRx: points.map((d) => ({ timestamp: d.timestamp, value: d.networkRxBytesPerSec })),
      networkTx: points.map((d) => ({ timestamp: d.timestamp, value: d.networkTxBytesPerSec })),
    };
  }, [dataPoints]);

  // Memoize formatted metric parts
  const metricParts = useMemo(() => {
    const networkRxBps = rates.networkRxBytesPerSec * 8;
    const networkTxBps = rates.networkTxBytesPerSec * 8;

    return {
      cpu: formatAsPercentParts(rates.cpuPercent / 100, decimals.cpu),
      memory: docker.memoryDisplayMode === 'bytes'
        ? formatBytesParts(container.memory_stats.usage, false, decimals.memory)
        : formatAsPercentParts(rates.memoryPercent / 100, decimals.memory),
      blockRead: formatBytesParts(rates.blockIoReadBytesPerSec, true, decimals.diskSpeed),
      blockWrite: formatBytesParts(rates.blockIoWriteBytesPerSec, true, decimals.diskSpeed),
      networkRx: formatBitsSIUnitsParts(networkRxBps, true, decimals.networkSpeed),
      networkTx: formatBitsSIUnitsParts(networkTxBps, true, decimals.networkSpeed),
    };
  }, [
    rates.cpuPercent, rates.memoryPercent,
    rates.blockIoReadBytesPerSec, rates.blockIoWriteBytesPerSec,
    rates.networkRxBytesPerSec, rates.networkTxBytesPerSec,
    container.memory_stats.usage, docker.memoryDisplayMode,
    decimals.cpu, decimals.memory, decimals.diskSpeed, decimals.networkSpeed,
  ]);

  const handleClick = () => {
    toggleContainerExpanded(container.id);
  };

  return (
    <>
      <div
        onClick={handleClick}
        className={`group ${DOCKER_GRID} items-center cursor-pointer transition-[background-color,box-shadow] duration-150 ${
          container.stale
            ? 'bg-amber-500/10 opacity-70 hover:bg-amber-500/15 hover:shadow-[inset_0_0_0_1px_rgba(245,158,11,0.4)]'
            : 'hover:bg-blue-500/5 hover:shadow-[inset_0_0_0_1px_rgba(59,130,246,0.3)]'
        }`}
      >
        <div className="px-3 py-2 pl-8">
          <div className="flex items-center gap-2">
            <ChevronRight
              size={16}
              className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
            />

            {/* Container update indicator - pulses when stats update */}
            <Tooltip
              title={lastUpdated ? `Last updated: ${lastUpdated.toLocaleTimeString()}` : 'No data yet'}
              placement="top"
              arrow
            >
              <div className="relative w-2 h-2 flex-shrink-0">
                <div
                  className={`absolute inset-0 rounded-full transition-opacity duration-200 ${
                    isPulsing ? 'opacity-100 animate-ping' : 'opacity-0'
                  }`}
                  style={{ backgroundColor: 'var(--chart-cpu)' }}
                />
                <div
                  className={`absolute inset-0 rounded-full transition-opacity duration-200 ${
                    isPulsing ? 'opacity-100' : 'opacity-0'
                  }`}
                  style={{ backgroundColor: 'var(--chart-cpu)' }}
                />
              </div>
            </Tooltip>

            <img
              src={iconError ? FALLBACK_ICON_URL : iconUrl}
              alt=""
              className="w-5 h-5 flex-shrink-0"
              onError={() => setIconError(true)}
            />
            <span className="truncate">{container.name}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIconPickerOpen(true);
              }}
              className="p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-neutral-500/20"
              aria-label="Change container icon"
            >
              <Settings size={14} />
            </button>
          </div>
        </div>
        <div className="pr-16">
          <MetricValue
            value={metricParts.cpu.value}
            unit={metricParts.cpu.unit}
            hasDecimals={decimals.cpu}
            color="cpu"
            isStale={container.stale}
            sparkline={showSparklines && <SparklineChart data={sparklines.cpu} color="--chart-cpu" className="hidden lg:block" />}
          />
        </div>
        <div className="pr-16">
          <MetricValue
            value={metricParts.memory.value}
            unit={metricParts.memory.unit}
            hasDecimals={decimals.memory}
            color="memory"
            isStale={container.stale}
            sparkline={showSparklines && <SparklineChart data={sparklines.memory} color="--chart-memory" className="hidden lg:block" />}
          />
        </div>
        <div className="pr-16">
          <MetricValue
            value={metricParts.blockRead.value}
            unit={metricParts.blockRead.unit}
            hasDecimals={decimals.diskSpeed}
            color="read"
            isStale={container.stale}
            sparkline={showSparklines && <SparklineChart data={sparklines.blockRead} color="--chart-read" className="hidden lg:block" />}
          />
        </div>
        <div className="pr-16">
          <MetricValue
            value={metricParts.blockWrite.value}
            unit={metricParts.blockWrite.unit}
            hasDecimals={decimals.diskSpeed}
            color="write"
            isStale={container.stale}
            sparkline={showSparklines && <SparklineChart data={sparklines.blockWrite} color="--chart-write" className="hidden lg:block" />}
          />
        </div>
        <div className="pr-16">
          <MetricValue
            value={metricParts.networkRx.value}
            unit={metricParts.networkRx.unit}
            hasDecimals={decimals.networkSpeed}
            color="read"
            isStale={container.stale}
            sparkline={showSparklines && <SparklineChart data={sparklines.networkRx} color="--chart-read" className="hidden lg:block" />}
          />
        </div>
        <div className="pr-16">
          <MetricValue
            value={metricParts.networkTx.value}
            unit={metricParts.networkTx.unit}
            hasDecimals={decimals.networkSpeed}
            color="write"
            isStale={container.stale}
            sparkline={showSparklines && <SparklineChart data={sparklines.networkTx} color="--chart-write" className="hidden lg:block" />}
          />
        </div>
      </div>

      {expanded && (
        <ContainerChartsCard dataPoints={dataPoints} />
      )}

      {iconPickerOpen && (
        <IconPickerDialog
          open={iconPickerOpen}
          onClose={() => setIconPickerOpen(false)}
          onSelect={handleIconSelect}
          currentIcon={container.icon}
          containerName={container.name}
        />
      )}
    </>
  );
});
