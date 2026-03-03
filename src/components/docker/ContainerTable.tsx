import { useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { useSettings } from '@/hooks/useSettings';
import { Box, Chip, CircularProgress, Paper, Typography } from '@mui/material';
import { ChevronRight, Server, WifiOff } from 'lucide-react';
import { StaleDataAlert } from '@/components/shared-table/StaleDataAlert';
import type { DockerStatsRow, DockerStatsFromDB, DockerHierarchy, HostStats } from '@/types/docker';
import { buildDockerHierarchy, rowToDockerStats } from '@/lib/utils/docker-hierarchy-builder';
import { formatAsPercentParts, formatBytesParts, formatBitsSIUnitsParts } from '@/formatters/metrics';
import { MetricValue, MetricHeader } from '../shared-table';
import ContainerRow from './ContainerRow';
import { getDockerEntityIcons } from '@/data/docker.functions';

export const DOCKER_ENTITY_ICONS_QUERY_KEY = ['docker-entity-icons'] as const;

type FlatRow =
  | { type: 'host'; host: HostStats; totalHosts: number }
  | { type: 'container'; container: DockerStatsFromDB; chartData: DockerStatsRow[] };

const ROW_HEIGHT_ESTIMATE = 41;
const EXPANDED_ROW_HEIGHT_ESTIMATE = 550;
const OVERSCAN = 10;

export const DOCKER_GRID = 'grid grid-cols-[minmax(300px,20%)_repeat(6,minmax(0,1fr))] min-w-[600px]';

interface ContainerTableProps {
  latestByEntity: Map<string, DockerStatsRow>;
  rows: DockerStatsRow[];
  hasData: boolean;
  isConnected: boolean;
  error: Error | null;
  isStale: boolean;
}

/**
 * Render a virtualized, expandable table of Docker hosts and their containers showing CPU, memory, disk and network metrics.
 *
 * Builds a host/container hierarchy from the latest per-entity stats, associates time-series chart data for each entity, and fetches entity icon metadata to augment rows. Hosts can be expanded to reveal their containers; rows are virtualized for large lists and sized according to expansion state.
 *
 * @param latestByEntity - Map of the most recent DockerStatsRow keyed by `host/container_id` used to derive the host/container hierarchy and metadata.
 * @param rows - Time-series DockerStatsRow entries used as chart data for individual entities.
 * @param hasData - True when any historical or latest data is available; controls loading/error fallbacks.
 * @param isConnected - True when the Docker stats source is currently connected; controls loading UI when no data exists.
 * @param error - Optional connection error to display when no data is available.
 * @param isStale - True when displayed data is known to be stale; used to show a stale-data alert.
 * @returns The rendered ContainerTable React element.
 */
export default function ContainerTable({
  latestByEntity,
  rows,
  hasData,
  isConnected,
  error,
  isStale,
}: ContainerTableProps) {
  const { docker, isHostExpanded, isContainerExpanded } = useSettings();

  const { data: entityIcons } = useQuery({
    queryKey: DOCKER_ENTITY_ICONS_QUERY_KEY,
    queryFn: () => getDockerEntityIcons(),
    staleTime: 60_000,
  });

  // Convert latest rows to DockerStatsFromDB and build hierarchy.
  // Deduplicate by serviceKeyEntity so that when a container is recreated
  // (new container_id, same logical service), only the most recently active
  // incarnation is shown in the live dashboard.
  const hierarchy = useMemo<DockerHierarchy>(() => {
    const byServiceKey = new Map<string, DockerStatsFromDB>();
    for (const row of latestByEntity.values()) {
      const entityId = `${row.host}/${row.container_id}`;
      const name = row.container_name || row.container_id.substring(0, 12);
      const meta = entityIcons?.[entityId];
      const stat = rowToDockerStats(row, meta?.iconSlug ?? null, meta?.serviceKeyEntity ?? `${row.host}/${name}`);
      const existing = byServiceKey.get(stat.serviceKeyEntity);
      if (!existing || stat.timestamp > existing.timestamp) {
        byServiceKey.set(stat.serviceKeyEntity, stat);
      }
    }
    return buildDockerHierarchy([...byServiceKey.values()]);
  }, [latestByEntity, entityIcons]);

  // Build per-service chart data index, keyed by serviceKeyEntity so rows from
  // all incarnations of the same service (different container IDs) are merged.
  const chartDataByServiceKey = useMemo(() => {
    const map = new Map<string, DockerStatsRow[]>();
    for (const row of rows) {
      const entityId = `${row.host}/${row.container_id}`;
      const name = row.container_name || row.container_id.substring(0, 12);
      const serviceKey = entityIcons?.[entityId]?.serviceKeyEntity ?? `${row.host}/${name}`;
      let arr = map.get(serviceKey);
      if (!arr) {
        arr = [];
        map.set(serviceKey, arr);
      }
      arr.push(row);
    }
    return map;
  }, [rows, entityIcons]);

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
            chartData: chartDataByServiceKey.get(container.data.serviceKeyEntity) ?? [],
          });
        }
      }
    }
    return result;
  }, [hierarchy, isHostExpanded, chartDataByServiceKey]);

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
          <Typography color="error">
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
      <StaleDataAlert isStale={isStale} />
      <Paper variant="outlined" className="rounded-sm overflow-x-auto">
        {/* Shared min-w container ensures header and virtualizer body resolve to the same width */}
        <div className="min-w-[600px]">
        {/* Column headers */}
        <div className={`${DOCKER_GRID} border-b border-neutral-200 dark:border-neutral-700`}>
          <div className="px-3 py-2 font-semibold text-sm whitespace-nowrap">Host / Container</div>
          <div className="py-2"><MetricHeader>CPU</MetricHeader></div>
          <div className="py-2"><MetricHeader>{memLabel}</MetricHeader></div>
          <div className="py-2"><MetricHeader>Disk Read</MetricHeader></div>
          <div className="py-2"><MetricHeader>Disk Write</MetricHeader></div>
          <div className="py-2"><MetricHeader>Net RX</MetricHeader></div>
          <div className="py-2"><MetricHeader>Net TX</MetricHeader></div>
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
        </div>
      </Paper>
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
      className={`${DOCKER_GRID} items-center border-t border-neutral-200 dark:border-neutral-700 ${
        hasContainers && totalHosts > 1 ? 'cursor-pointer' : 'cursor-default'
      } ${host.isStale ? 'bg-amber-500/10' : 'bg-[var(--mui-palette-background-level1)]'}`}
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
        <Chip size="small" variant="filled" label={`${a.containerCount} container${a.containerCount !== 1 ? 's' : ''}`} />
        {a.staleContainerCount > 0 && !host.isStale && (
          <Chip size="small" variant="filled" color="warning" label={`${a.staleContainerCount} stale`} />
        )}
      </div>
      <div>
        <MetricValue value={cpuParts.value} unit={cpuParts.unit} hasDecimals={decimals.cpu} />
      </div>
      <div>
        <MetricValue value={memoryParts.value} unit={memoryParts.unit} hasDecimals={decimals.memory} />
      </div>
      <div>
        <MetricValue value={blockReadParts.value} unit={blockReadParts.unit} hasDecimals={decimals.diskSpeed} />
      </div>
      <div>
        <MetricValue value={blockWriteParts.value} unit={blockWriteParts.unit} hasDecimals={decimals.diskSpeed} />
      </div>
      <div>
        <MetricValue value={networkRxParts.value} unit={networkRxParts.unit} hasDecimals={decimals.networkSpeed} />
      </div>
      <div>
        <MetricValue value={networkTxParts.value} unit={networkTxParts.unit} hasDecimals={decimals.networkSpeed} />
      </div>
    </div>
  );
}
