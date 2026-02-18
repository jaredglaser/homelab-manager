import { useMemo, useRef } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { useSettings } from '@/hooks/useSettings';
import { Alert, Box, Chip, CircularProgress, Sheet, Typography } from '@mui/joy';
import { AlertTriangle, ChevronRight, Server, WifiOff } from 'lucide-react';
import type { DockerStatsRow, DockerStatsFromDB, DockerHierarchy, HostStats } from '@/types/docker';
import { buildDockerHierarchy, rowToDockerStats } from '@/lib/utils/docker-hierarchy-builder';
import { formatAsPercentParts, formatBytesParts, formatBitsSIUnitsParts } from '@/formatters/metrics';
import { MetricValue } from '../shared-table';
import ContainerRow from './ContainerRow';

type FlatRow =
  | { type: 'host'; host: HostStats; totalHosts: number }
  | { type: 'container'; container: DockerStatsFromDB; chartData: DockerStatsRow[] };

const ROW_HEIGHT_ESTIMATE = 41;
const EXPANDED_ROW_HEIGHT_ESTIMATE = 350;
const OVERSCAN = 10;

export const DOCKER_GRID = 'grid grid-cols-[20%_repeat(6,1fr)] min-w-[800px]';

interface ContainerTableProps {
  latestByEntity: Map<string, DockerStatsRow>;
  rows: DockerStatsRow[];
  hasData: boolean;
  isConnected: boolean;
  error: Error | null;
  isStale: boolean;
}

export default function ContainerTable({
  latestByEntity,
  rows,
  hasData,
  isConnected,
  error,
  isStale,
}: ContainerTableProps) {
  const { docker, isHostExpanded, isContainerExpanded } = useSettings();

  // Convert latest rows to DockerStatsFromDB and build hierarchy
  const hierarchy = useMemo<DockerHierarchy>(() => {
    const stats: DockerStatsFromDB[] = [];
    for (const row of latestByEntity.values()) {
      stats.push(rowToDockerStats(row));
    }
    return buildDockerHierarchy(stats);
  }, [latestByEntity]);

  // Build per-entity chart data index
  const chartDataByEntity = useMemo(() => {
    const map = new Map<string, DockerStatsRow[]>();
    for (const row of rows) {
      const entity = `${row.host}/${row.container_id}`;
      let arr = map.get(entity);
      if (!arr) {
        arr = [];
        map.set(entity, arr);
      }
      arr.push(row);
    }
    return map;
  }, [rows]);

  // Flatten hierarchy into a single virtual row list
  const flatRows = useMemo<FlatRow[]>(() => {
    const result: FlatRow[] = [];
    const totalHosts = hierarchy.size;
    for (const host of hierarchy.values()) {
      result.push({ type: 'host', host, totalHosts });
      if (isHostExpanded(host.hostName, totalHosts)) {
        for (const container of host.containers.values()) {
          result.push({
            type: 'container',
            container: container.data,
            chartData: chartDataByEntity.get(container.data.id) ?? [],
          });
        }
      }
    }
    return result;
  }, [hierarchy, isHostExpanded, chartDataByEntity]);

  const listRef = useRef<HTMLDivElement>(null);

  const virtualizer = useWindowVirtualizer({
    count: flatRows.length,
    estimateSize: (index: number) => {
      const row = flatRows[index];
      if (row.type === 'host') return ROW_HEIGHT_ESTIMATE;
      return isContainerExpanded(row.container.id) ? EXPANDED_ROW_HEIGHT_ESTIMATE : ROW_HEIGHT_ESTIMATE;
    },
    overscan: OVERSCAN,
    scrollMargin: listRef.current?.offsetTop ?? 0,
    getItemKey: (index: number) => {
      const row = flatRows[index];
      return row.type === 'host' ? `host-${row.host.hostName}` : `ctr-${row.container.id}`;
    },
  });

  const items = virtualizer.getVirtualItems();
  const memLabel = docker.memoryDisplayMode === 'percentage' ? 'RAM %' : 'RAM';

  // Loading / error states
  if (error && !hasData) {
    return (
      <Box className="w-full">
        <Box className="p-2">
          <Typography color="danger">
            Error connecting to Docker stats: {error.message}
          </Typography>
        </Box>
      </Box>
    );
  }

  if (!isConnected && !hasData) {
    return (
      <Box className="w-full">
        <Box className="flex justify-center p-4">
          <CircularProgress />
        </Box>
      </Box>
    );
  }

  return (
    <Box className="w-full">
      {isStale && (
        <Alert
          color="warning"
          variant="soft"
          startDecorator={<AlertTriangle size={18} />}
          className="mb-3"
        >
          Data is stale. Background worker may not be running.
        </Alert>
      )}
      <Sheet variant="outlined" className="rounded-sm overflow-hidden">
        {/* Column headers */}
        <div className={`${DOCKER_GRID} border-b border-neutral-200 dark:border-neutral-700`}>
          <div className="px-3 py-2 font-semibold text-sm whitespace-nowrap">Host / Container</div>
          <div className="px-3 py-2 font-semibold text-sm text-right pr-16 whitespace-nowrap">CPU</div>
          <div className="px-3 py-2 font-semibold text-sm text-right pr-16 whitespace-nowrap">{memLabel}</div>
          <div className="px-3 py-2 font-semibold text-sm text-right pr-16 whitespace-nowrap">Disk Read</div>
          <div className="px-3 py-2 font-semibold text-sm text-right pr-16 whitespace-nowrap">Disk Write</div>
          <div className="px-3 py-2 font-semibold text-sm text-right pr-16 whitespace-nowrap">Net RX</div>
          <div className="px-3 py-2 font-semibold text-sm text-right pr-16 whitespace-nowrap">Net TX</div>
        </div>

        {/* Virtualized body */}
        <div ref={listRef}>
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: '100%',
              position: 'relative',
              willChange: 'transform',
              contain: 'layout style',
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translate3d(0, ${(items[0]?.start ?? 0) - virtualizer.options.scrollMargin}px, 0)`,
              }}
            >
              {items.map((virtualRow) => {
                const row = flatRows[virtualRow.index];
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                  >
                    {row.type === 'host' ? (
                      <HostRow host={row.host} totalHosts={row.totalHosts} />
                    ) : (
                      <ContainerRow container={row.container} chartData={row.chartData} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </Sheet>
    </Box>
  );
}

// ─── Host Row ────────────────────────────────────────────────────────────────

function HostRow({ host, totalHosts }: { host: HostStats; totalHosts: number }) {
  const { docker, isHostExpanded, toggleHostExpanded } = useSettings();
  const { decimals } = docker;
  const expanded = isHostExpanded(host.hostName, totalHosts);
  const hasContainers = host.containers.size > 0;

  const handleClick = () => {
    if (hasContainers && totalHosts > 1) {
      toggleHostExpanded(host.hostName);
    }
  };

  const a = host.aggregated;
  const networkRxBps = a.networkRxBytesPerSec * 8;
  const networkTxBps = a.networkTxBytesPerSec * 8;

  const cpuParts = formatAsPercentParts(a.cpuPercent / 100, decimals.cpu);
  const memoryParts = docker.memoryDisplayMode === 'bytes'
    ? formatBytesParts(a.memoryUsage, false, decimals.memory)
    : formatAsPercentParts(a.memoryPercent / 100, decimals.memory);
  const blockReadParts = formatBytesParts(a.blockIoReadBytesPerSec, true, decimals.diskSpeed);
  const blockWriteParts = formatBytesParts(a.blockIoWriteBytesPerSec, true, decimals.diskSpeed);
  const networkRxParts = formatBitsSIUnitsParts(networkRxBps, true, decimals.networkSpeed);
  const networkTxParts = formatBitsSIUnitsParts(networkTxBps, true, decimals.networkSpeed);

  return (
    <div
      onClick={handleClick}
      className={`${DOCKER_GRID} items-center ${
        hasContainers && totalHosts > 1 ? 'cursor-pointer' : 'cursor-default'
      } ${host.isStale ? 'bg-amber-500/10' : ''}`}
    >
      <div className="px-3 py-2 flex items-center gap-2">
        {hasContainers && totalHosts > 1 && (
          <ChevronRight
            size={18}
            className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
        )}
        <Server size={18} />
        {host.isStale && (
          <WifiOff size={16} className="text-amber-600 dark:text-amber-400 flex-shrink-0" />
        )}
        <span className="font-bold">{host.hostName}</span>
        <Chip size="sm" variant="soft">
          {a.containerCount} container{a.containerCount !== 1 ? 's' : ''}
        </Chip>
        {a.staleContainerCount > 0 && !host.isStale && (
          <Chip size="sm" variant="soft" color="warning">
            {a.staleContainerCount} stale
          </Chip>
        )}
      </div>
      <div className="pr-16">
        <MetricValue value={cpuParts.value} unit={cpuParts.unit} hasDecimals={decimals.cpu} />
      </div>
      <div className="pr-16">
        <MetricValue value={memoryParts.value} unit={memoryParts.unit} hasDecimals={decimals.memory} />
      </div>
      <div className="pr-16">
        <MetricValue value={blockReadParts.value} unit={blockReadParts.unit} hasDecimals={decimals.diskSpeed} />
      </div>
      <div className="pr-16">
        <MetricValue value={blockWriteParts.value} unit={blockWriteParts.unit} hasDecimals={decimals.diskSpeed} />
      </div>
      <div className="pr-16">
        <MetricValue value={networkRxParts.value} unit={networkRxParts.unit} hasDecimals={decimals.networkSpeed} />
      </div>
      <div className="pr-16">
        <MetricValue value={networkTxParts.value} unit={networkTxParts.unit} hasDecimals={decimals.networkSpeed} />
      </div>
    </div>
  );
}
