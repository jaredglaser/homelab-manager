import { memo, useMemo, useRef, useState, useEffect } from 'react';
import { ChevronRight, History, Settings } from 'lucide-react';
import { Collapse, IconButton, Tooltip } from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import type { DockerStatsFromDB, DockerStatsRow } from '@/types/docker';
import { formatAsPercentParts, formatBytesParts, formatBitsSIUnitsParts } from '@/formatters/metrics';
import { MetricValue } from '@/components/shared-table';
import { useSettings } from '@/hooks/useSettings';
import ContainerChartsCard from '@/components/docker/ContainerChartsCard';
import SparklineChart from '@/components/docker/SparklineChart';
import IconPickerDialog from '@/components/docker/IconPickerDialog';
import { getIconUrl, FALLBACK_ICON_URL } from '@/lib/utils/icon-resolver';
import { updateContainerIcon } from '@/data/docker.functions';
import { DOCKER_GRID, DOCKER_ENTITY_ICONS_QUERY_KEY } from '@/components/docker/ContainerTable';
import { PULSE_DURATION_MS, LATE_THRESHOLD_MS } from '@/lib/constants/ui-timing';

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
  onOpenHistory?: (containerId: string, host: string) => void;
}

export default memo(function ContainerRow({ container, chartData, onOpenHistory }: ContainerRowProps) {
  const { general, docker, toggleContainerExpanded, isContainerExpanded } = useSettings();
  const { rates } = container;
  const { decimals } = docker;
  const { showSparklines } = general;
  const expanded = isContainerExpanded(container.id);

  const queryClient = useQueryClient();
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [iconError, setIconError] = useState(false);
  const [isPulsing, setIsPulsing] = useState(false);
  const [isLate, setIsLate] = useState(false);

  const iconUrl = getIconUrl(container.icon, container.image);

  const handleIconSelect = async (iconSlug: string) => {
    await updateContainerIcon({ data: { serviceKeyEntity: container.serviceKeyEntity, iconSlug } });
    await queryClient.invalidateQueries({ queryKey: DOCKER_ENTITY_ICONS_QUERY_KEY });
  };

  // Get last update timestamp from most recent chart data
  const lastUpdated = chartData.length > 0 ? new Date(chartData[chartData.length - 1].time) : undefined;
  const lastUpdatedMs = lastUpdated?.getTime() ?? 0;
  const lastUpdatedMsRef = useRef(lastUpdatedMs);

  // Detect when container stats update and trigger pulse animation
  useEffect(() => {
    if (lastUpdatedMs > 0 && lastUpdatedMs !== lastUpdatedMsRef.current) {
      lastUpdatedMsRef.current = lastUpdatedMs;
      setIsPulsing(true);
      setIsLate(false);
      const pulseTimer = setTimeout(() => setIsPulsing(false), PULSE_DURATION_MS);
      const lateTimer = setTimeout(() => setIsLate(true), LATE_THRESHOLD_MS);
      return () => {
        clearTimeout(pulseTimer);
        clearTimeout(lateTimer);
      };
    }
  }, [lastUpdatedMs]);

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

  // Sparkline accumulator: isolates sparkline data from chart buffer re-fetches.
  // Only accumulates NEW data points (by timestamp). When the chart window changes
  // and the buffer is re-fetched with a different time_bucket resolution, re-bucketed
  // data doesn't have newer timestamps than what we've already seen, so sparklines
  // stay visually stable. After ~35s all initial bucketed data is evicted and replaced
  // with raw 1s-resolution SSE data.
  const sparkAccRef = useRef<ChartDataPoint[]>([]);
  const sparkMaxTsRef = useRef(0);
  const sparkSeededRef = useRef(false);

  const [sparklines, setSparklines] = useState(() => ({
    cpu: [] as { timestamp: number; value: number }[],
    memory: [] as { timestamp: number; value: number }[],
    blockRead: [] as { timestamp: number; value: number }[],
    blockWrite: [] as { timestamp: number; value: number }[],
    networkRx: [] as { timestamp: number; value: number }[],
    networkTx: [] as { timestamp: number; value: number }[],
  }));

  useEffect(() => {
    if (dataPoints.length === 0) return;

    const latest = dataPoints[dataPoints.length - 1].timestamp;

    if (!sparkSeededRef.current) {
      // First data: seed with all points in the sparkline window
      sparkSeededRef.current = true;
      const cutoff = latest - 35000;
      sparkAccRef.current = dataPoints.filter((d) => d.timestamp >= cutoff);
      sparkMaxTsRef.current = latest;
    } else if (latest > sparkMaxTsRef.current) {
      // New data arrived: add only points newer than our tracked max
      const newPoints = dataPoints.filter((d) => d.timestamp > sparkMaxTsRef.current);
      const combined = [...sparkAccRef.current, ...newPoints];
      // Evict points outside the sparkline window
      const cutoff = latest - 35000;
      sparkAccRef.current = combined.filter((d) => d.timestamp >= cutoff);
      sparkMaxTsRef.current = latest;
    } else {
      // Buffer swap (re-bucketed data, same time range): skip update
      return;
    }

    const points = sparkAccRef.current;
    setSparklines({
      cpu: points.map((d) => ({ timestamp: d.timestamp, value: d.cpuPercent })),
      memory: points.map((d) => ({ timestamp: d.timestamp, value: d.memoryPercent })),
      blockRead: points.map((d) => ({ timestamp: d.timestamp, value: d.blockIoReadBytesPerSec })),
      blockWrite: points.map((d) => ({ timestamp: d.timestamp, value: d.blockIoWriteBytesPerSec })),
      networkRx: points.map((d) => ({ timestamp: d.timestamp, value: d.networkRxBytesPerSec })),
      networkTx: points.map((d) => ({ timestamp: d.timestamp, value: d.networkTxBytesPerSec })),
    });
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
            : expanded
              ? 'bg-[var(--mui-palette-action-hover)]'
              : 'hover:bg-blue-500/5 hover:shadow-[inset_0_0_0_1px_rgba(59,130,246,0.3)]'
        }`}
      >
        <div className="px-3 py-2">
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
                  style={{ backgroundColor: isLate ? 'var(--indicator-late)' : 'var(--indicator-active)' }}
                />
                <div
                  className="absolute inset-0 rounded-full transition-colors duration-300"
                  style={{ backgroundColor: isLate ? 'var(--indicator-late)' : 'var(--indicator-active)' }}
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
            <IconButton
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                setIconPickerOpen(true);
              }}
              className="!p-1 !opacity-0 group-hover:!opacity-100 !transition-opacity"
              aria-label="Change container icon"
            >
              <Settings size={14} />
            </IconButton>
            {onOpenHistory && (
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenHistory(container.id.split('/')[1], container.id.split('/')[0]);
                }}
                className="!p-1 !opacity-0 group-hover:!opacity-100 !transition-opacity"
                aria-label="View container history"
              >
                <History size={14} />
              </IconButton>
            )}
          </div>
        </div>
        <div>
          <MetricValue
            value={metricParts.cpu.value}
            unit={metricParts.cpu.unit}
            hasDecimals={decimals.cpu}

            isStale={container.stale}
            sparkline={showSparklines && <SparklineChart data={sparklines.cpu} color="--chart-cpu" className="hidden min-[1428px]:block" />}
          />
        </div>
        <div>
          <MetricValue
            value={metricParts.memory.value}
            unit={metricParts.memory.unit}
            hasDecimals={decimals.memory}

            isStale={container.stale}
            sparkline={showSparklines && <SparklineChart data={sparklines.memory} color="--chart-memory" className="hidden min-[1428px]:block" />}
          />
        </div>
        <div >
          <MetricValue
            value={metricParts.blockRead.value}
            unit={metricParts.blockRead.unit}
            hasDecimals={decimals.diskSpeed}

            isStale={container.stale}
            sparkline={showSparklines && <SparklineChart data={sparklines.blockRead} color="--chart-read" className="hidden min-[1428px]:block" />}
          />
        </div>
        <div >
          <MetricValue
            value={metricParts.blockWrite.value}
            unit={metricParts.blockWrite.unit}
            hasDecimals={decimals.diskSpeed}

            isStale={container.stale}
            sparkline={showSparklines && <SparklineChart data={sparklines.blockWrite} color="--chart-write" className="hidden min-[1428px]:block" />}
          />
        </div>
        <div>
          <MetricValue
            value={metricParts.networkRx.value}
            unit={metricParts.networkRx.unit}
            hasDecimals={decimals.networkSpeed}

            isStale={container.stale}
            sparkline={showSparklines && <SparklineChart data={sparklines.networkRx} color="--chart-read" className="hidden min-[1428px]:block" />}
          />
        </div>
        <div>
          <MetricValue
            value={metricParts.networkTx.value}
            unit={metricParts.networkTx.unit}
            hasDecimals={decimals.networkSpeed}

            isStale={container.stale}
            sparkline={showSparklines && <SparklineChart data={sparklines.networkTx} color="--chart-write" className="hidden min-[1428px]:block" />}
          />
        </div>
      </div>

      <Collapse in={expanded} unmountOnExit>
        <ContainerChartsCard
          dataPoints={dataPoints}
          containerId={container.id.split('/')[1]}
          host={container.id.split('/')[0]}
        />
      </Collapse>

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
