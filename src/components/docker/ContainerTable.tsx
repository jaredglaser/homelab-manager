import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef, ExpandedState } from '@tanstack/react-table';
import { Box, Chip, CircularProgress, IconButton, Typography } from '@mui/material';
import { ChevronRight, History, Server, Settings, WifiOff } from 'lucide-react';
import { useSettings } from '@/hooks/useSettings';
import { useToast } from '@/hooks/toastAtom';
import { StaleDataAlert } from '@/components/shared-table/StaleDataAlert';
import { DataTable, type MetricGroup } from '@/components/shared-table/DataTable';
import { metricColumn, nameColumn } from '@/components/shared-table/columns';
import { formatAsPercentParts, formatBytesParts, formatBitsSIUnitsParts } from '@/formatters/metrics';
import type {
  DockerStatsRow,
  DockerStatsFromDB,
  DockerHostTableRow,
  DockerContainerTableRow,
  DockerTableRow,
  HostAggregatedStats,
} from '@/types/docker';
import type { DockerContainerInventory } from '@/types/docker-inventory';
import { buildDockerTableHierarchy, rowToDockerStats, totalContainers } from '@/lib/utils/docker-hierarchy-builder';
import { getDockerEntityIcons, updateContainerIcon } from '@/data/docker/functions';
import { getIconUrl, FALLBACK_ICON_URL } from '@/lib/utils/icon-resolver';
import IconPickerDialog from '@/components/docker/IconPickerDialog';
import ContainerDetailPanel from '@/components/docker/ContainerDetailPanel';
import ContainerStateChip from '@/components/docker/ContainerStateChip';
import { usePulseIndicator } from '@/hooks/usePulseIndicator';
import { buildContainerChartData } from '@/hooks/useContainerChartData';

export const DOCKER_ENTITY_ICONS_QUERY_KEY = ['docker-entity-icons'] as const;

const METRIC_GROUPS: MetricGroup[] = [
  { label: 'CPU/Mem', columnIds: ['cpu', 'memory'] },
  { label: 'Disk', columnIds: ['diskRead', 'diskWrite'] },
  { label: 'Network', columnIds: ['netRx', 'netTx'] },
];

interface ContainerTableProps {
  inventory: Map<string, DockerContainerInventory>;
  /** Whether the inventory SSE stream has connected (false until first event received) */
  isInventoryConnected: boolean;
  /** Error from the inventory SSE stream, if it permanently failed */
  inventoryError?: Error | null;
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
 *
 * Inventory is the source of truth for which rows exist. Stats merge in for
 * running containers; stopped/paused containers show dashes and a state chip.
 */
export default function ContainerTable({
  inventory,
  isInventoryConnected,
  inventoryError = null,
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

  const prevStatsRef = useRef<Map<string, DockerStatsFromDB>>(new Map());

  const statsByEntityId = useMemo<Map<string, DockerStatsFromDB>>(() => {
    const next = new Map<string, DockerStatsFromDB>();
    const prev = prevStatsRef.current;

    for (const row of latestByEntity.values()) {
      const entityId = `${row.host}/${row.container_id}`;
      const name = row.container_name || row.container_id.substring(0, 12);
      const meta = entityIcons?.[entityId];
      const stat = rowToDockerStats(row, meta?.iconSlug ?? null, meta?.serviceKeyEntity ?? `${row.host}/${name}`);

      const prevStat = prev.get(entityId);
      const reuse = prevStat?.timestamp.getTime() === stat.timestamp.getTime();
      next.set(entityId, reuse ? prevStat : stat);
    }

    prevStatsRef.current = next;
    return next;
  }, [latestByEntity, entityIcons]);

  const prevChartDataRef = useRef<Map<string, DockerStatsRow[]>>(new Map());

  const chartDataByEntityId = useMemo(() => {
    const map = new Map<string, DockerStatsRow[]>();
    for (const row of rows) {
      const entityId = `${row.host}/${row.container_id}`;
      let arr = map.get(entityId);
      if (!arr) {
        arr = [];
        map.set(entityId, arr);
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
  }, [rows]);

  const tableData = useMemo<DockerTableRow[]>(() => {
    const { hosts } = buildDockerTableHierarchy(inventory, statsByEntityId);

    return hosts.map((hostRow) => {
      const enrichedChildren: DockerContainerTableRow[] = hostRow.children.map((c) => {
        const chartData = chartDataByEntityId.get(c.id) ?? [];
        const { sparklineData, dataPoints } = buildContainerChartData(chartData);
        return { ...c, chartData, sparklineData, dataPoints };
      });
      return { ...hostRow, children: enrichedChildren };
    });
  }, [inventory, statsByEntityId, chartDataByEntityId]);

  const expandedState = useMemo<ExpandedState>(() => {
    const state: Record<string, boolean> = {};
    for (const hostRow of tableData) {
      if (hostRow.type === 'host') {
        state[hostRow.id] = isHostExpanded(hostRow.hostName, hostRow.totalHosts);
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
          if (row.type === 'host') return row.hostName;
          return row.inventory.name;
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
          if (row.type === 'host') {
            return formatAsPercentParts(row.aggregated.cpuPercent / 100, docker.decimals.cpu);
          }
          if (!row.stats) return { value: '—', unit: '' };
          return formatAsPercentParts(row.stats.rates.cpuPercent / 100, docker.decimals.cpu);
        },
        getSparklineData: (row) => (row.type === 'container' ? (row.sparklineData?.cpu ?? []) : []),
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
          if (row.type === 'host') {
            return docker.memoryDisplayMode === 'bytes'
              ? formatBytesParts(row.aggregated.memoryUsage, false, docker.decimals.memory)
              : formatAsPercentParts(row.aggregated.memoryPercent / 100, docker.decimals.memory);
          }
          if (!row.stats) return { value: '—', unit: '' };
          return docker.memoryDisplayMode === 'bytes'
            ? formatBytesParts(row.stats.memory_stats.usage, false, docker.decimals.memory)
            : formatAsPercentParts(row.stats.rates.memoryPercent / 100, docker.decimals.memory);
        },
        getSparklineData: (row) => (row.type === 'container' ? (row.sparklineData?.memory ?? []) : []),
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
          if (row.type === 'host') {
            return formatBytesParts(row.aggregated.blockIoReadBytesPerSec, true, docker.decimals.diskSpeed);
          }
          if (!row.stats) return { value: '—', unit: '' };
          return formatBytesParts(row.stats.rates.blockIoReadBytesPerSec, true, docker.decimals.diskSpeed);
        },
        getSparklineData: (row) => (row.type === 'container' ? (row.sparklineData?.blockRead ?? []) : []),
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
          if (row.type === 'host') {
            return formatBytesParts(row.aggregated.blockIoWriteBytesPerSec, true, docker.decimals.diskSpeed);
          }
          if (!row.stats) return { value: '—', unit: '' };
          return formatBytesParts(row.stats.rates.blockIoWriteBytesPerSec, true, docker.decimals.diskSpeed);
        },
        getSparklineData: (row) => (row.type === 'container' ? (row.sparklineData?.blockWrite ?? []) : []),
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
          if (row.type === 'host') {
            return formatBitsSIUnitsParts(row.aggregated.networkRxBytesPerSec * 8, true, docker.decimals.networkSpeed);
          }
          if (!row.stats) return { value: '—', unit: '' };
          return formatBitsSIUnitsParts(row.stats.rates.networkRxBytesPerSec * 8, true, docker.decimals.networkSpeed);
        },
        getSparklineData: (row) => (row.type === 'container' ? (row.sparklineData?.networkRx ?? []) : []),
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
          if (row.type === 'host') {
            return formatBitsSIUnitsParts(row.aggregated.networkTxBytesPerSec * 8, true, docker.decimals.networkSpeed);
          }
          if (!row.stats) return { value: '—', unit: '' };
          return formatBitsSIUnitsParts(row.stats.rates.networkTxBytesPerSec * 8, true, docker.decimals.networkSpeed);
        },
        getSparklineData: (row) => (row.type === 'container' ? (row.sparklineData?.networkTx ?? []) : []),
        getIsStale: (row) => row.isStale,
      }),
    ],
    [docker.decimals.cpu, docker.decimals.memory, docker.decimals.diskSpeed, docker.decimals.networkSpeed, docker.memoryDisplayMode, memLabel, general.showSparklines, general.useAbbreviatedUnits, onOpenHistory],
  );

  /** Render container detail panel (charts + logs) for the nested DataTable */
  const renderContainerDetail = useCallback(
    (row: DockerTableRow) => {
      if (row.type !== 'container' || !row.dataPoints) return null;
      const [host, containerId] = row.id.split('/');
      if (!host || !containerId) return null;
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
    const { state } = row.inventory;
    if (state !== 'running' && state !== 'restarting') {
      return '!opacity-60';
    }
    return '';
  }, []);

  const rowAttributes = useCallback((row: DockerTableRow): Record<string, string> => {
    if (row.type === 'host') {
      return { 'data-row-variant': row.isStale ? 'stale' : 'host' };
    }
    if (row.isStale) return { 'data-row-variant': 'stale' };
    const { state } = row.inventory;
    if (state === 'running' || state === 'restarting') {
      return { 'data-row-variant': 'running' };
    }
    return { 'data-row-variant': 'stopped' };
  }, []);

  /** Host detail panel: a nested DataTable of container rows with its own virtualized scroll */
  const renderDetailPanel = useCallback(
    (row: DockerTableRow) => {
      if (row.type !== 'host' || !row.children.length) return null;
      return (
        <ContainerSubTable
          containers={row.children}
          columns={columns}
          renderDetailPanel={renderContainerDetail}
          rowClassName={rowClassName}
          rowAttributes={rowAttributes}
          isContainerExpanded={isContainerExpanded}
          toggleContainerExpanded={toggleContainerExpanded}
        />
      );
    },
    [columns, renderContainerDetail, rowClassName, rowAttributes, isContainerExpanded, toggleContainerExpanded],
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

  if (inventoryError && inventory.size === 0) {
    return (
      <Box className="w-full">
        <Box className="p-2">
          <Typography color="error">
            Error connecting to Docker inventory: {inventoryError.message}
          </Typography>
        </Box>
      </Box>
    );
  }

  // Show spinner until both streams are ready: stats SSE (isConnected or hasData)
  // and inventory SSE (isInventoryConnected or inventory has data). Without this guard,
  // the table would render zero rows when stats arrive before inventory.
  if ((!isConnected && !hasData) || (!isInventoryConnected && inventory.size === 0)) {
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
        rowAttributes={rowAttributes}
        enableSorting={false}
      />
    </Box>
  );
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
  rowAttributes,
  isContainerExpanded,
  toggleContainerExpanded,
}: Readonly<{
  containers: DockerContainerTableRow[];
  columns: ColumnDef<DockerTableRow, unknown>[];
  renderDetailPanel: (row: DockerTableRow) => ReactNode;
  rowClassName: (row: DockerTableRow) => string;
  rowAttributes: (row: DockerTableRow) => Record<string, string>;
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
      rowAttributes={rowAttributes}
      enableSorting={false}
      showHeader={false}
    />
  );
});

const HostNameCell = memo(function HostNameCell({
  row,
  expanded,
}: Readonly<{
  row: DockerHostTableRow;
  expanded: boolean;
}>) {
  const { totalHosts, children, aggregated: a } = row;
  const hasContainers = children.length > 0;
  const canToggle = hasContainers && totalHosts > 1;

  const countLabel = buildCountLabel(a);

  return (
    <div className="flex items-center gap-2">
      {canToggle && (
        <ChevronRight
          size={18}
          className={`flex-shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />
      )}
      <Server size={18} className="flex-shrink-0" />
      {row.isStale && (
        <WifiOff size={16} className="text-amber-600 dark:text-amber-400 flex-shrink-0" />
      )}
      <span className="font-bold">{row.hostName}</span>
      <Chip size="small" variant="filled" label={countLabel} />
      {a.staleContainerCount > 0 && !row.isStale && (
        <Chip size="small" variant="filled" color="warning" label={`${a.staleContainerCount} stale`} />
      )}
    </div>
  );
});

/**
 * Build a human-readable container count label for the host chip.
 * Shows a breakdown when containers are in mixed states.
 */
function buildCountLabel(a: HostAggregatedStats): string {
  const total = totalContainers(a);
  const nonRunning = total - a.runningCount;

  if (nonRunning === 0) {
    return `${total} container${total === 1 ? '' : 's'}`;
  }

  const parts: string[] = [];
  if (a.runningCount > 0) parts.push(`${a.runningCount} running`);
  if (a.stoppedCount > 0) parts.push(`${a.stoppedCount} stopped`);
  if (a.restartingCount > 0) parts.push(`${a.restartingCount} restarting`);
  if (a.pausedCount > 0) parts.push(`${a.pausedCount} paused`);
  if (a.otherCount > 0) parts.push(`${a.otherCount} other`);

  return parts.join(' · ');
}

/**
 * Name cell for container rows — shows icon, pulse indicator, state chip, name,
 * settings and history buttons. Uses hooks for pulse animation and icon picker.
 */
function ContainerNameCell({
  row,
  expanded,
  onOpenHistory,
}: Readonly<{
  row: DockerContainerTableRow;
  expanded: boolean;
  onOpenHistory?: (containerId: string, host: string) => void;
}>) {
  const { inventory, stats } = row;

  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [iconError, setIconError] = useState(false);

  const iconUrl = getIconUrl(stats?.icon ?? null, inventory.image);

  useEffect(() => {
    setIconError(false);
  }, [iconUrl]);

  const lastChartRow = row.chartData?.at(-1);
  const lastUpdated = lastChartRow ? new Date(lastChartRow.time) : undefined;
  const lastUpdatedMs = lastUpdated?.getTime() ?? 0;
  const { indicatorRef, pingRef, dotRef } = usePulseIndicator(lastUpdatedMs);

  const handleIconSelect = async (iconSlug: string) => {
    try {
      const serviceKeyEntity = stats?.serviceKeyEntity ?? `${inventory.host}/${inventory.name}`;
      await updateContainerIcon({ data: { serviceKeyEntity, iconSlug } });
      await queryClient.invalidateQueries({ queryKey: DOCKER_ENTITY_ICONS_QUERY_KEY });
    } catch (err) {
      console.error('Failed to update container icon:', err);
      showToast('Failed to update icon. Please try again.');
    }
  };

  const handleHistoryClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const [host, containerId] = row.id.split('/');
    if (host && containerId && onOpenHistory) onOpenHistory(containerId, host);
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <ChevronRight
          size={16}
          className={`flex-shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />

        {/* Pulse indicator — for running and restarting containers with data */}
        {(inventory.state === 'running' || inventory.state === 'restarting') && (
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
        )}
        {inventory.state !== 'running' && (
          <ContainerStateChip state={inventory.state} />
        )}

        <img
          src={iconError ? FALLBACK_ICON_URL : iconUrl}
          alt=""
          className="w-5 h-5 flex-shrink-0"
          onError={() => setIconError(true)}
        />
        <span className="truncate">{inventory.name}</span>
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
            onClick={handleHistoryClick}
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
          currentIcon={stats?.icon ?? null}
          containerName={inventory.name}
        />
      )}
    </>
  );
}
