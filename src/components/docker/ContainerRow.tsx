import { memo, useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { ChevronRight, History, Settings } from 'lucide-react';
import { Collapse } from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import type { DockerStatsFromDB, DockerStatsRow } from '@/types/docker';
import type { DecimalSettings, MemoryDisplayMode } from '@/hooks/useSettings';
import { formatAsPercentParts, formatBytesParts, formatBitsSIUnitsParts } from '@/formatters/metrics';
import { MetricValue } from '@/components/shared-table';
import ContainerChartsCard from '@/components/docker/ContainerChartsCard';
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
  expanded: boolean;
  toggleContainerExpanded: (containerId: string) => void;
  decimals: DecimalSettings;
  memoryDisplayMode: MemoryDisplayMode;
  showSparklines: boolean;
  useAbbreviatedUnits: boolean;
  onOpenHistory?: (containerId: string, host: string) => void;
}

export default memo(function ContainerRow({
  container,
  chartData,
  expanded,
  toggleContainerExpanded,
  decimals,
  memoryDisplayMode,
  showSparklines,
  useAbbreviatedUnits,
  onOpenHistory,
}: ContainerRowProps) {
  const { rates } = container;

  const queryClient = useQueryClient();
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [iconError, setIconError] = useState(false);
  const iconUrl = getIconUrl(container.icon, container.image);

  const handleIconSelect = async (iconSlug: string) => {
    await updateContainerIcon({ data: { serviceKeyEntity: container.serviceKeyEntity, iconSlug } });
    await queryClient.invalidateQueries({ queryKey: DOCKER_ENTITY_ICONS_QUERY_KEY });
  };

  // Get last update timestamp from most recent chart data
  const lastUpdated = chartData.length > 0 ? new Date(chartData[chartData.length - 1].time) : undefined;
  const lastUpdatedMs = lastUpdated?.getTime() ?? 0;
  const lastUpdatedMsRef = useRef(lastUpdatedMs);

  // Pulse animation + tooltip via direct DOM manipulation to avoid re-render per tick
  const indicatorRef = useRef<HTMLDivElement>(null);
  const pingRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (lastUpdatedMs > 0 && lastUpdatedMs !== lastUpdatedMsRef.current) {
      lastUpdatedMsRef.current = lastUpdatedMs;

      const indicator = indicatorRef.current;
      if (indicator) indicator.title = `Last updated: ${new Date(lastUpdatedMs).toLocaleTimeString()}`;

      const ping = pingRef.current;
      const dot = dotRef.current;
      if (ping) { ping.classList.add('opacity-100', 'animate-ping'); ping.classList.remove('opacity-0'); }
      if (ping && dot) {
        ping.style.backgroundColor = 'var(--indicator-active)';
        dot.style.backgroundColor = 'var(--indicator-active)';
      }

      const pulseTimer = setTimeout(() => {
        if (ping) { ping.classList.remove('opacity-100', 'animate-ping'); ping.classList.add('opacity-0'); }
      }, PULSE_DURATION_MS);
      const lateTimer = setTimeout(() => {
        if (ping) ping.style.backgroundColor = 'var(--indicator-late)';
        if (dot) dot.style.backgroundColor = 'var(--indicator-late)';
      }, LATE_THRESHOLD_MS);
      return () => {
        clearTimeout(pulseTimer);
        clearTimeout(lateTimer);
      };
    }
  }, [lastUpdatedMs]);

  // Convert wide rows to chart data points and sparkline data in a single pass
  const { dataPoints, sparklineData } = useMemo(() => {
    const points: ChartDataPoint[] = new Array(chartData.length);
    const cpu: { timestamp: number; value: number }[] = new Array(chartData.length);
    const memory: { timestamp: number; value: number }[] = new Array(chartData.length);
    const blockRead: { timestamp: number; value: number }[] = new Array(chartData.length);
    const blockWrite: { timestamp: number; value: number }[] = new Array(chartData.length);
    const networkRx: { timestamp: number; value: number }[] = new Array(chartData.length);
    const networkTx: { timestamp: number; value: number }[] = new Array(chartData.length);

    for (let i = 0; i < chartData.length; i++) {
      const row = chartData[i];
      const timestamp = new Date(row.time).getTime();
      const cpuPercent = row.cpu_percent ?? 0;
      const memoryPercent = row.memory_percent ?? 0;
      const blockIoRead = row.block_io_read_bytes_per_sec ?? 0;
      const blockIoWrite = row.block_io_write_bytes_per_sec ?? 0;
      const netRx = row.network_rx_bytes_per_sec ?? 0;
      const netTx = row.network_tx_bytes_per_sec ?? 0;

      points[i] = { timestamp, cpuPercent, memoryPercent, blockIoReadBytesPerSec: blockIoRead, blockIoWriteBytesPerSec: blockIoWrite, networkRxBytesPerSec: netRx, networkTxBytesPerSec: netTx };
      cpu[i] = { timestamp, value: cpuPercent };
      memory[i] = { timestamp, value: memoryPercent };
      blockRead[i] = { timestamp, value: blockIoRead };
      blockWrite[i] = { timestamp, value: blockIoWrite };
      networkRx[i] = { timestamp, value: netRx };
      networkTx[i] = { timestamp, value: netTx };
    }

    return { dataPoints: points, sparklineData: { cpu, memory, blockRead, blockWrite, networkRx, networkTx } };
  }, [chartData]);

  // Memoize formatted metric parts
  const metricParts = useMemo(() => {
    const networkRxBps = rates.networkRxBytesPerSec * 8;
    const networkTxBps = rates.networkTxBytesPerSec * 8;

    return {
      cpu: formatAsPercentParts(rates.cpuPercent / 100, decimals.cpu),
      memory: memoryDisplayMode === 'bytes'
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
    container.memory_stats.usage, memoryDisplayMode,
    decimals.cpu, decimals.memory, decimals.diskSpeed, decimals.networkSpeed,
  ]);

  const rowRef = useRef<HTMLDivElement>(null);

  const handleClick = () => {
    toggleContainerExpanded(container.id);
  };

  const handleExpanded = useCallback(() => {
    if (expanded && rowRef.current) {
      const el = rowRef.current;
      // Delay to let the virtualizer settle after the Collapse animation
      setTimeout(() => {
        const rect = el.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const headerAbove = rect.top < 0;
        const contentBelow = rect.bottom > viewportHeight;

        if (headerAbove || contentBelow) {
          if (headerAbove) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } else if (rect.height <= viewportHeight) {
            el.scrollIntoView({ behavior: 'smooth', block: 'end' });
          } else {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
      }, 50);
    }
  }, [expanded]);

  return (
    <div ref={rowRef}>
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
            <div
              ref={indicatorRef}
              className="relative w-2 h-2 flex-shrink-0"
              title={lastUpdated ? `Last updated: ${lastUpdated.toLocaleTimeString()}` : 'No data yet'}
            >
              <div
                ref={pingRef}
                className="absolute inset-0 rounded-full transition-opacity duration-200 opacity-0"
                style={{ backgroundColor: 'var(--indicator-active)' }}
              />
              <div
                ref={dotRef}
                className="absolute inset-0 rounded-full transition-colors duration-300"
                style={{ backgroundColor: 'var(--indicator-active)' }}
              />
            </div>

            <img
              src={iconError ? FALLBACK_ICON_URL : iconUrl}
              alt=""
              className="w-5 h-5 flex-shrink-0"
              onError={() => setIconError(true)}
            />
            <span className="truncate">{container.name}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIconPickerOpen(true);
              }}
              className={`p-1 rounded-full transition-opacity hover:bg-black/10 dark:hover:bg-white/10 ${expanded ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
              aria-label="Change container icon"
              tabIndex={expanded ? 0 : -1}
              aria-hidden={!expanded}
            >
              <Settings size={14} />
            </button>
            {onOpenHistory && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenHistory(container.id.split('/')[1], container.id.split('/')[0]);
                }}
                className={`p-1 rounded-full transition-opacity hover:bg-black/10 dark:hover:bg-white/10 ${expanded ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
                aria-label="View container history"
                tabIndex={expanded ? 0 : -1}
                aria-hidden={!expanded}
              >
                <History size={14} />
              </button>
            )}
          </div>
        </div>
        <div>
          <MetricValue
            value={metricParts.cpu.value}
            unit={metricParts.cpu.unit}
            hasDecimals={decimals.cpu}
            showSparklines={showSparklines}
            useAbbreviatedUnits={useAbbreviatedUnits}
            isStale={container.stale}
            sparklineData={sparklineData.cpu}
            sparklineColor="--chart-cpu"
          />
        </div>
        <div>
          <MetricValue
            value={metricParts.memory.value}
            unit={metricParts.memory.unit}
            hasDecimals={decimals.memory}
            showSparklines={showSparklines}
            useAbbreviatedUnits={useAbbreviatedUnits}
            isStale={container.stale}
            sparklineData={sparklineData.memory}
            sparklineColor="--chart-memory"
          />
        </div>
        <div>
          <MetricValue
            value={metricParts.blockRead.value}
            unit={metricParts.blockRead.unit}
            hasDecimals={decimals.diskSpeed}
            showSparklines={showSparklines}
            useAbbreviatedUnits={useAbbreviatedUnits}
            isStale={container.stale}
            sparklineData={sparklineData.blockRead}
            sparklineColor="--chart-read"
          />
        </div>
        <div>
          <MetricValue
            value={metricParts.blockWrite.value}
            unit={metricParts.blockWrite.unit}
            hasDecimals={decimals.diskSpeed}
            showSparklines={showSparklines}
            useAbbreviatedUnits={useAbbreviatedUnits}
            isStale={container.stale}
            sparklineData={sparklineData.blockWrite}
            sparklineColor="--chart-write"
          />
        </div>
        <div>
          <MetricValue
            value={metricParts.networkRx.value}
            unit={metricParts.networkRx.unit}
            hasDecimals={decimals.networkSpeed}
            showSparklines={showSparklines}
            useAbbreviatedUnits={useAbbreviatedUnits}
            isStale={container.stale}
            sparklineData={sparklineData.networkRx}
            sparklineColor="--chart-read"
          />
        </div>
        <div>
          <MetricValue
            value={metricParts.networkTx.value}
            unit={metricParts.networkTx.unit}
            hasDecimals={decimals.networkSpeed}
            showSparklines={showSparklines}
            useAbbreviatedUnits={useAbbreviatedUnits}
            isStale={container.stale}
            sparklineData={sparklineData.networkTx}
            sparklineColor="--chart-write"
          />
        </div>
      </div>

      <Collapse in={expanded} unmountOnExit onEntered={handleExpanded}>
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
    </div>
  );
});
