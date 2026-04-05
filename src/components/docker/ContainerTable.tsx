import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef, ExpandedState } from '@tanstack/react-table';
import { Box, Chip, CircularProgress, IconButton, Typography } from '@mui/material';
import { ChevronRight, History, Server, Settings, WifiOff } from 'lucide-react';
import { useSettings } from '@/hooks/useSettings';
import { StaleDataAlert } from '@/components/shared-table/StaleDataAlert';
import { DataTable, type MetricGroup } from '@/components/shared-table/DataTable';
import { metricColumn, nameColumn } from '@/components/shared-table/columns';
import { formatAsPercentParts, formatBytesParts, formatBitsSIUnitsParts } from '@/formatters/metrics';
import type { DockerStatsRow, DockerStatsFromDB, DockerHierarchy, HostAggregatedStats } from '@/types/docker';
import { buildDockerHierarchy, rowToDockerStats } from '@/lib/utils/docker-hierarchy-builder';
import { getDockerEntityIcons, updateContainerIcon } from '@/data/docker/functions';
import { getIconUrl, FALLBACK_ICON_URL } from '@/lib/utils/icon-resolver';
import IconPickerDialog from '@/components/docker/IconPickerDialog';
import ContainerDetailPanel from '@/components/docker/ContainerDetailPanel';
import { PULSE_DURATION_MS, LATE_THRESHOLD_MS } from '@/lib/constants/ui-timing';

export const DOCKER_ENTITY_ICONS_QUERY_KEY = ['docker-entity-icons'] as const;

/** Flattened row model for the DataTable tree structure */
export interface DockerTableRow {
  type: 'host' | 'container';
  id: string;
  isStale: boolean;
  /** Host fields */
  hostName?: string;
  aggregated?: HostAggregatedStats;
  totalHosts?: number;
  /** Container fields */
  container?: DockerStatsFromDB;
  chartData?: DockerStatsRow[];
  /** Pre-computed sparkline data for container rows */
  sparklineData?: SparklineDataSet;
  /** Pre-computed chart data points for container detail panel */
  dataPoints?: ChartDataPoint[];
  /** Tree children: containers under a host */
  children?: DockerTableRow[];
}

interface SparklineDataSet {
  cpu: { timestamp: number; value: number }[];
  memory: { timestamp: number; value: number }[];
  blockRead: { timestamp: number; value: number }[];
  blockWrite: { timestamp: number; value: number }[];
  networkRx: { timestamp: number; value: number }[];
  networkTx: { timestamp: number; value: number }[];
}

interface ChartDataPoint {
  timestamp: number;
  cpuPercent: number;
  memoryPercent: number;
  blockIoReadBytesPerSec: number;
  blockIoWriteBytesPerSec: number;
  networkRxBytesPerSec: number;
  networkTxBytesPerSec: number;
}

const METRIC_GROUPS: MetricGroup[] = [
  { label: 'CPU/Mem', columnIds: ['cpu', 'memory'] },
  { label: 'Disk', columnIds: ['diskRead', 'diskWrite'] },
  { label: 'Network', columnIds: ['netRx', 'netTx'] },
];

interface ContainerTableProps {
  latestByEntity: Map<string, DockerStatsRow>;
  rows: DockerStatsRow[];
  hasData: boolean;
  isConnected: boolean;
  error: Error | null;
  isStale: boolean;
  onOpenHistory?: (containerId: string, host: string) => void;
}

/**
 * Render a virtualized, expandable table of Docker hosts and their containers
 * showing CPU, memory, disk and network metrics. Uses the shared DataTable
 * component with tree data (hosts -> containers) and detail panels.
 */
export default function ContainerTable({
  latestByEntity,
  rows,
  hasData,
  isConnected,
  error,
  isStale,
  onOpenHistory,
}: Readonly<ContainerTableProps>) {
  const {
    docker,
    general,
    isHostExpanded,
    isContainerExpanded,
    toggleHostExpanded,
    toggleContainerExpanded,
  } = useSettings();

  const { data: entityIcons } = useQuery({
    queryKey: DOCKER_ENTITY_ICONS_QUERY_KEY,
    queryFn: () => getDockerEntityIcons(),
    staleTime: 60_000,
  });

  // Convert latest rows to DockerStatsFromDB and build hierarchy.
  // Deduplicate by serviceKeyEntity so that when a container is recreated
  // (new container_id, same logical service), only the most recently active
  // incarnation is shown in the live dashboard.
  const prevContainersRef = useRef<Map<string, DockerStatsFromDB>>(new Map());

  const hierarchy = useMemo<DockerHierarchy>(() => {
    const byServiceKey = new Map<string, DockerStatsFromDB>();
    const prev = prevContainersRef.current;

    for (const row of latestByEntity.values()) {
      const entityId = `${row.host}/${row.container_id}`;
      const name = row.container_name || row.container_id.substring(0, 12);
      const meta = entityIcons?.[entityId];
      const stat = rowToDockerStats(row, meta?.iconSlug ?? null, meta?.serviceKeyEntity ?? `${row.host}/${name}`);

      // Reuse previous object if the underlying data hasn't changed
      const prevStat = prev.get(stat.serviceKeyEntity);
      const reuse = prevStat?.timestamp === stat.timestamp;

      const existing = byServiceKey.get(stat.serviceKeyEntity);
      if (!existing || stat.timestamp > existing.timestamp) {
        byServiceKey.set(stat.serviceKeyEntity, reuse ? prevStat : stat);
      }
    }

    prevContainersRef.current = byServiceKey;
    return buildDockerHierarchy([...byServiceKey.values()]);
  }, [latestByEntity, entityIcons]);

  // Build per-service chart data index, keyed by serviceKeyEntity
  const prevChartDataRef = useRef<Map<string, DockerStatsRow[]>>(new Map());

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

    // Reuse previous array references when content hasn't changed
    const prev = prevChartDataRef.current;
    for (const [key, arr] of map) {
      const prevArr = prev.get(key);
      if (prevArr?.length === arr.length && prevArr.at(-1) === arr.at(-1)) {
        map.set(key, prevArr);
      }
    }

    prevChartDataRef.current = map;
    return map;
  }, [rows, entityIcons]);

  // Build tree data for DataTable
  const tableData = useMemo<DockerTableRow[]>(() => {
    const totalHosts = hierarchy.size;
    const hosts = Array.from(hierarchy.values()).sort((a, b) => a.hostName.localeCompare(b.hostName));

    return hosts.map((host) => {
      const containers = Array.from(host.containers.values())
        .sort((a, b) => a.data.name.localeCompare(b.data.name));

      const children: DockerTableRow[] = containers.map((c) => {
        const chartData = chartDataByServiceKey.get(c.data.serviceKeyEntity) ?? [];
        const { sparklineData, dataPoints } = computeSparklineAndChartData(chartData);

        return {
          type: 'container' as const,
          id: c.data.id,
          isStale: c.data.stale,
          container: c.data,
          chartData,
          sparklineData,
          dataPoints,
        };
      });

      return {
        type: 'host' as const,
        id: `host:${host.hostName}`,
        isStale: host.isStale,
        hostName: host.hostName,
        aggregated: host.aggregated,
        totalHosts,
        children,
      };
    });
  }, [hierarchy, chartDataByServiceKey]);

  // Host-level expansion state (container expansion handled by nested DataTable)
  const expandedState = useMemo<ExpandedState>(() => {
    const state: Record<string, boolean> = {};
    for (const hostRow of tableData) {
      if (hostRow.type === 'host' && hostRow.hostName) {
        state[hostRow.id] = isHostExpanded(hostRow.hostName, hostRow.totalHosts ?? 1);
      }
    }
    return state;
  }, [tableData, isHostExpanded]);

  const handleExpandedChange = useCallback(
    (newExpanded: ExpandedState) => {
      if (typeof newExpanded === 'boolean') return;
      const currentExpanded = expandedState as Record<string, boolean>;
      for (const [id, value] of Object.entries(newExpanded)) {
        if (value !== (currentExpanded[id] ?? false) && id.startsWith('host:')) {
          toggleHostExpanded(id.slice(5));
        }
      }
      for (const id of Object.keys(currentExpanded)) {
        if (currentExpanded[id] && !(id in newExpanded) && id.startsWith('host:')) {
          toggleHostExpanded(id.slice(5));
        }
      }
    },
    [expandedState, toggleHostExpanded],
  );

  // Build columns with current settings
  const memLabel = docker.memoryDisplayMode === 'percentage' ? 'RAM %' : 'RAM';

  const columns = useMemo<ColumnDef<DockerTableRow, unknown>[]>(
    () => [
      nameColumn<DockerTableRow>({
        getLabel: (row) => {
          if (row.type === 'host') return row.hostName ?? '';
          return row.container?.name ?? '';
        },
        size: 300,
        cell: ({ row }) => {
          const data = row.original;
          if (data.type === 'host') {
            return (
              <HostNameCell
                row={data}
                expanded={row.getIsExpanded()}
              />
            );
          }
          return (
            <ContainerNameCell
              row={data}
              expanded={row.getIsExpanded()}
              onOpenHistory={onOpenHistory}
            />
          );
        },
      }),
      metricColumn<DockerTableRow>({
        id: 'cpu',
        header: 'CPU',
        hasDecimals: docker.decimals.cpu,
        showSparklines: general.showSparklines,
        useAbbreviatedUnits: general.useAbbreviatedUnits,
        sparklineColor: '--chart-cpu',
        getValue: (row) => {
          if (row.type === 'host' && row.aggregated) {
            return formatAsPercentParts(row.aggregated.cpuPercent / 100, docker.decimals.cpu);
          }
          if (row.container) {
            return formatAsPercentParts(row.container.rates.cpuPercent / 100, docker.decimals.cpu);
          }
          return { value: '--', unit: '' };
        },
        getSparklineData: (row) => row.sparklineData?.cpu ?? [],
        getIsStale: (row) => row.isStale,
      }),
      metricColumn<DockerTableRow>({
        id: 'memory',
        header: memLabel,
        hasDecimals: docker.decimals.memory,
        showSparklines: general.showSparklines,
        useAbbreviatedUnits: general.useAbbreviatedUnits,
        sparklineColor: '--chart-memory',
        getValue: (row) => {
          if (row.type === 'host' && row.aggregated) {
            return docker.memoryDisplayMode === 'bytes'
              ? formatBytesParts(row.aggregated.memoryUsage, false, docker.decimals.memory)
              : formatAsPercentParts(row.aggregated.memoryPercent / 100, docker.decimals.memory);
          }
          if (row.container) {
            return docker.memoryDisplayMode === 'bytes'
              ? formatBytesParts(row.container.memory_stats.usage, false, docker.decimals.memory)
              : formatAsPercentParts(row.container.rates.memoryPercent / 100, docker.decimals.memory);
          }
          return { value: '--', unit: '' };
        },
        getSparklineData: (row) => row.sparklineData?.memory ?? [],
        getIsStale: (row) => row.isStale,
      }),
      metricColumn<DockerTableRow>({
        id: 'diskRead',
        header: 'Disk Read',
        hasDecimals: docker.decimals.diskSpeed,
        showSparklines: general.showSparklines,
        useAbbreviatedUnits: general.useAbbreviatedUnits,
        sparklineColor: '--chart-read',
        getValue: (row) => {
          if (row.type === 'host' && row.aggregated) {
            return formatBytesParts(row.aggregated.blockIoReadBytesPerSec, true, docker.decimals.diskSpeed);
          }
          if (row.container) {
            return formatBytesParts(row.container.rates.blockIoReadBytesPerSec, true, docker.decimals.diskSpeed);
          }
          return { value: '--', unit: '' };
        },
        getSparklineData: (row) => row.sparklineData?.blockRead ?? [],
        getIsStale: (row) => row.isStale,
      }),
      metricColumn<DockerTableRow>({
        id: 'diskWrite',
        header: 'Disk Write',
        hasDecimals: docker.decimals.diskSpeed,
        showSparklines: general.showSparklines,
        useAbbreviatedUnits: general.useAbbreviatedUnits,
        sparklineColor: '--chart-write',
        getValue: (row) => {
          if (row.type === 'host' && row.aggregated) {
            return formatBytesParts(row.aggregated.blockIoWriteBytesPerSec, true, docker.decimals.diskSpeed);
          }
          if (row.container) {
            return formatBytesParts(row.container.rates.blockIoWriteBytesPerSec, true, docker.decimals.diskSpeed);
          }
          return { value: '--', unit: '' };
        },
        getSparklineData: (row) => row.sparklineData?.blockWrite ?? [],
        getIsStale: (row) => row.isStale,
      }),
      metricColumn<DockerTableRow>({
        id: 'netRx',
        header: 'Net RX',
        hasDecimals: docker.decimals.networkSpeed,
        showSparklines: general.showSparklines,
        useAbbreviatedUnits: general.useAbbreviatedUnits,
        sparklineColor: '--chart-read',
        getValue: (row) => {
          if (row.type === 'host' && row.aggregated) {
            return formatBitsSIUnitsParts(row.aggregated.networkRxBytesPerSec * 8, true, docker.decimals.networkSpeed);
          }
          if (row.container) {
            return formatBitsSIUnitsParts(row.container.rates.networkRxBytesPerSec * 8, true, docker.decimals.networkSpeed);
          }
          return { value: '--', unit: '' };
        },
        getSparklineData: (row) => row.sparklineData?.networkRx ?? [],
        getIsStale: (row) => row.isStale,
      }),
      metricColumn<DockerTableRow>({
        id: 'netTx',
        header: 'Net TX',
        hasDecimals: docker.decimals.networkSpeed,
        showSparklines: general.showSparklines,
        useAbbreviatedUnits: general.useAbbreviatedUnits,
        sparklineColor: '--chart-write',
        getValue: (row) => {
          if (row.type === 'host' && row.aggregated) {
            return formatBitsSIUnitsParts(row.aggregated.networkTxBytesPerSec * 8, true, docker.decimals.networkSpeed);
          }
          if (row.container) {
            return formatBitsSIUnitsParts(row.container.rates.networkTxBytesPerSec * 8, true, docker.decimals.networkSpeed);
          }
          return { value: '--', unit: '' };
        },
        getSparklineData: (row) => row.sparklineData?.networkTx ?? [],
        getIsStale: (row) => row.isStale,
      }),
    ],
    [docker.decimals.cpu, docker.decimals.memory, docker.decimals.diskSpeed, docker.decimals.networkSpeed, docker.memoryDisplayMode, memLabel, general.showSparklines, general.useAbbreviatedUnits, onOpenHistory],
  );

  /** Render container detail panel (charts + logs) for the nested DataTable */
  const renderContainerDetail = useCallback(
    (row: DockerTableRow) => {
      if (row.type !== 'container' || !row.container || !row.dataPoints) return null;
      const [host, containerId] = row.container.id.split('/');
      return (
        <ContainerDetailPanel
          dataPoints={row.dataPoints}
          containerId={containerId}
          host={host}
        />
      );
    },
    [],
  );

  const rowClassName = useCallback((row: DockerTableRow) => {
    if (row.type === 'host') {
      return row.isStale
        ? '!bg-amber-500/10'
        : '!bg-[var(--mui-palette-background-level1)]';
    }
    if (row.isStale) {
      return '!bg-amber-500/10 !opacity-70';
    }
    return '';
  }, []);

  /** Host detail panel: a nested DataTable of container rows with its own virtualized scroll */
  const renderDetailPanel = useCallback(
    (row: DockerTableRow) => {
      if (row.type !== 'host' || !row.children?.length) return null;
      return (
        <ContainerSubTable
          containers={row.children}
          columns={columns}
          renderDetailPanel={renderContainerDetail}
          rowClassName={rowClassName}
          isContainerExpanded={isContainerExpanded}
          toggleContainerExpanded={toggleContainerExpanded}
        />
      );
    },
    [columns, renderContainerDetail, rowClassName, isContainerExpanded, toggleContainerExpanded],
  );

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
    <Box className="flex flex-col flex-1 min-h-0 w-full">
      <StaleDataAlert isStale={isStale} />
      <DataTable
        data={tableData}
        columns={columns}
        getRowId={(row) => row.id}
        renderDetailPanel={renderDetailPanel}
        expandedState={expandedState}
        onExpandedChange={handleExpandedChange}
        metricGroups={METRIC_GROUPS}
        rowClassName={rowClassName}
        enableSorting={false}
      />
    </Box>
  );
}

/**
 * Pre-compute sparkline and chart data from raw DockerStatsRow entries.
 * Done outside the component tree so it can be memoized at the data level.
 */
function computeSparklineAndChartData(chartData: DockerStatsRow[]): {
  sparklineData: SparklineDataSet;
  dataPoints: ChartDataPoint[];
} {
  const cpu: { timestamp: number; value: number }[] = new Array(chartData.length);
  const memory: { timestamp: number; value: number }[] = new Array(chartData.length);
  const blockRead: { timestamp: number; value: number }[] = new Array(chartData.length);
  const blockWrite: { timestamp: number; value: number }[] = new Array(chartData.length);
  const networkRx: { timestamp: number; value: number }[] = new Array(chartData.length);
  const networkTx: { timestamp: number; value: number }[] = new Array(chartData.length);
  const points: ChartDataPoint[] = new Array(chartData.length);

  for (let i = 0; i < chartData.length; i++) {
    const row = chartData[i];
    const timestamp = new Date(row.time).getTime();
    const cpuPercent = row.cpu_percent ?? 0;
    const memoryPercent = row.memory_percent ?? 0;
    const blockIoRead = row.block_io_read_bytes_per_sec ?? 0;
    const blockIoWrite = row.block_io_write_bytes_per_sec ?? 0;
    const netRx = row.network_rx_bytes_per_sec ?? 0;
    const netTx = row.network_tx_bytes_per_sec ?? 0;

    cpu[i] = { timestamp, value: cpuPercent };
    memory[i] = { timestamp, value: memoryPercent };
    blockRead[i] = { timestamp, value: blockIoRead };
    blockWrite[i] = { timestamp, value: blockIoWrite };
    networkRx[i] = { timestamp, value: netRx };
    networkTx[i] = { timestamp, value: netTx };
    points[i] = { timestamp, cpuPercent, memoryPercent, blockIoReadBytesPerSec: blockIoRead, blockIoWriteBytesPerSec: blockIoWrite, networkRxBytesPerSec: netRx, networkTxBytesPerSec: netTx };
  }

  return {
    sparklineData: { cpu, memory, blockRead, blockWrite, networkRx, networkTx },
    dataPoints: points,
  };
}

/**
 * Nested DataTable for container rows within an expanded host.
 * Detail panel renders inline with MUI Collapse animation.
 */
const ContainerSubTable = memo(function ContainerSubTable({
  containers,
  columns,
  renderDetailPanel,
  rowClassName,
  isContainerExpanded,
  toggleContainerExpanded,
}: Readonly<{
  containers: DockerTableRow[];
  columns: ColumnDef<DockerTableRow, unknown>[];
  renderDetailPanel: (row: DockerTableRow) => ReactNode;
  rowClassName: (row: DockerTableRow) => string;
  isContainerExpanded: (id: string) => boolean;
  toggleContainerExpanded: (id: string) => void;
}>) {
  const containerExpanded = useMemo<ExpandedState>(() => {
    const state: Record<string, boolean> = {};
    for (const c of containers) {
      state[c.id] = isContainerExpanded(c.id);
    }
    return state;
  }, [containers, isContainerExpanded]);

  const handleContainerExpandedChange = useCallback(
    (newExpanded: ExpandedState) => {
      if (typeof newExpanded === 'boolean') return;
      const current = containerExpanded as Record<string, boolean>;
      for (const [id, value] of Object.entries(newExpanded)) {
        if (value !== (current[id] ?? false)) {
          toggleContainerExpanded(id);
        }
      }
      for (const id of Object.keys(current)) {
        if (current[id] && !(id in newExpanded)) {
          toggleContainerExpanded(id);
        }
      }
    },
    [containerExpanded, toggleContainerExpanded],
  );

  return (
    <DataTable
      data={containers}
      columns={columns}
      getRowId={(row) => row.id}
      renderDetailPanel={renderDetailPanel}
      expandedState={containerExpanded}
      onExpandedChange={handleContainerExpandedChange}
      rowClassName={rowClassName}
      enableSorting={false}
      showHeader={false}
    />
  );
});

const HostNameCell = memo(function HostNameCell({
  row,
  expanded,
}: Readonly<{
  row: DockerTableRow;
  expanded: boolean;
}>) {
  const totalHosts = row.totalHosts ?? 1;
  const hasContainers = (row.children?.length ?? 0) > 0;
  const canToggle = hasContainers && totalHosts > 1;
  const a = row.aggregated;

  return (
    <div className="flex items-center gap-2">
      {canToggle && (
        <ChevronRight
          size={18}
          className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />
      )}
      <Server size={18} />
      {row.isStale && (
        <WifiOff size={16} className="text-amber-600 dark:text-amber-400 flex-shrink-0" />
      )}
      <span className="font-bold">{row.hostName}</span>
      {a && (
        <Chip size="small" variant="filled" label={`${a.containerCount} container${a.containerCount !== 1 ? 's' : ''}`} />
      )}
      {a && a.staleContainerCount > 0 && !row.isStale && (
        <Chip size="small" variant="filled" color="warning" label={`${a.staleContainerCount} stale`} />
      )}
    </div>
  );
});

/**
 * Name cell for container rows - shows icon, pulse indicator, name,
 * settings and history buttons. Uses hooks for pulse animation and icon picker.
 */
function ContainerNameCell({
  row,
  expanded,
  onOpenHistory,
}: Readonly<{
  row: DockerTableRow;
  expanded: boolean;
  onOpenHistory?: (containerId: string, host: string) => void;
}>) {
  const container = row.container;
  if (!container) return null;

  const queryClient = useQueryClient();
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [iconError, setIconError] = useState(false);
  const iconUrl = getIconUrl(container.icon, container.image);

  const handleIconSelect = async (iconSlug: string) => {
    await updateContainerIcon({ data: { serviceKeyEntity: container.serviceKeyEntity, iconSlug } });
    await queryClient.invalidateQueries({ queryKey: DOCKER_ENTITY_ICONS_QUERY_KEY });
  };

  // Pulse indicator refs
  const lastUpdated = row.chartData && row.chartData.length > 0
    ? new Date(row.chartData[row.chartData.length - 1].time)
    : undefined;
  const lastUpdatedMs = lastUpdated?.getTime() ?? 0;
  const lastUpdatedMsRef = useRef(lastUpdatedMs);

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

  return (
    <>
      <div className="flex items-center gap-2">
        <ChevronRight
          size={16}
          className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />

        {/* Pulse indicator */}
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
        <IconButton
          size="small"
          onClick={(e) => {
            e.stopPropagation();
            setIconPickerOpen(true);
          }}
          className={`!p-1 transition-opacity ${expanded ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
          aria-label="Change container icon"
          tabIndex={expanded ? 0 : -1}
          aria-hidden={!expanded}
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
            className={`!p-1 transition-opacity ${expanded ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
            aria-label="View container history"
            tabIndex={expanded ? 0 : -1}
            aria-hidden={!expanded}
          >
            <History size={14} />
          </IconButton>
        )}
      </div>

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
}
