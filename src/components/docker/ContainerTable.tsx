import { useCallback, useMemo, useRef } from 'react';
import type { ColumnDef, ExpandedState } from '@tanstack/react-table';
import { Spinner } from '@/components/ui/spinner';
import { useDockerSettings, useGeneralSettings } from '@/hooks/useSettings';
import { StaleDataAlert } from '@/components/ui/datatable/StaleDataAlert';
import { DataTable, type MetricGroup } from '@/components/ui/datatable/DataTable';
import { metricColumn, nameColumn } from '@/components/ui/datatable/columns';
import { EMPTY_METRIC } from '@/components/ui/datatable/MetricCell';
import { formatAsPercentParts, formatBytesParts, formatBitsSIUnitsParts } from '@/formatters/metrics';
import type {
  DockerStatsRow,
  DockerStatsFromDB,
  DockerContainerTableRow,
  DockerTableRow,
} from '@/types/docker';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';
import {
  attachStatsToHierarchy,
  buildDockerInventoryHierarchy,
  rowToDockerStats,
} from '@/lib/utils/docker-hierarchy-builder';
import ContainerDetailPanel from '@/components/docker/ContainerDetailPanel';
import { buildContainerChartData } from '@/hooks/useContainerChartData';
import HostNameCell from '@/components/docker/HostNameCell';
import ContainerNameCell from '@/components/docker/ContainerNameCell';
import ContainerSubTable from '@/components/docker/ContainerSubTable';

export const DOCKER_ENTITY_ICONS_QUERY_KEY = ['docker-entity-icons'] as const;

export type DockerEntityIconsMap = Record<string, { iconSlug: string | null; serviceKeyEntity: string }>;

const METRIC_GROUPS: MetricGroup[] = [
  { label: 'CPU/Mem', columnIds: ['cpu', 'memory'] },
  { label: 'Disk', columnIds: ['diskRead', 'diskWrite'] },
  { label: 'Network', columnIds: ['netRx', 'netTx'] },
];

/** Shared empty array so containers without stats keep a stable chartData reference */
const EMPTY_CHART_DATA: DockerStatsRow[] = [];

/** Sparkline accumulator key source: only container rows have a per-entity series. */
const sparklineEntityId = (row: DockerTableRow) => (row.type === 'container' ? row.id : undefined);

/** Per-entity chart derivations cached by chartData array identity */
type ChartArtifacts = { chartData: DockerStatsRow[] } & ReturnType<typeof buildContainerChartData>;

interface ContainerTableProps {
  inventory: Map<string, DockerInventorySnapshotContainer>;
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
  entityIcons: DockerEntityIconsMap;
  onIconChange: (serviceKeyEntity: string, iconSlug: string | null) => Promise<void>;
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
  entityIcons,
  onIconChange,
}: Readonly<ContainerTableProps>) {
  const {
    docker,
    isHostExpanded,
    isContainerExpanded,
    toggleHostExpanded,
    toggleContainerExpanded,
  } = useDockerSettings();
  const { general } = useGeneralSettings();

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

    // Reuse the previous array reference when no new row arrived for the entity.
    // Compare the last timestamp, not object identity: periodic buffer refreshes
    // replace row objects with fresh references even when no new data point exists,
    // and a rebuilt array would force every SparklineCell to redraw. Length must
    // also match so window eviction (rows dropping off the front) still rebuilds.
    const prev = prevChartDataRef.current;
    for (const [key, arr] of map) {
      const prevArr = prev.get(key);
      if (
        prevArr &&
        prevArr.length === arr.length &&
        prevArr.at(-1)!.time === arr.at(-1)!.time
      ) {
        map.set(key, prevArr);
      }
    }

    prevChartDataRef.current = map;
    return map;
  }, [rows]);

  // Inventory-only pass: serviceKey dedup, grouping, and row ordering survive
  // stats flushes (every second) and only rebuild when inventory actually changes.
  const inventoryHierarchy = useMemo(() => buildDockerInventoryHierarchy(inventory), [inventory]);

  const chartArtifactsRef = useRef<Map<string, ChartArtifacts>>(new Map());

  const tableData = useMemo<DockerTableRow[]>(() => {
    const { hosts } = attachStatsToHierarchy(inventoryHierarchy, statsByEntityId);
    const prevArtifacts = chartArtifactsRef.current;
    const nextArtifacts = new Map<string, ChartArtifacts>();

    const data = hosts.map((hostRow) => {
      const enrichedChildren: DockerContainerTableRow[] = hostRow.children.map((c) => {
        const chartData = chartDataByEntityId.get(c.id) ?? EMPTY_CHART_DATA;
        // Skip rebuilding sparkline/data point arrays when the chartData reference
        // is unchanged; stable references let memoized SparklineCells skip redraws.
        const prev = prevArtifacts.get(c.id);
        const artifacts =
          prev && prev.chartData === chartData
            ? prev
            : { chartData, ...buildContainerChartData(chartData) };
        nextArtifacts.set(c.id, artifacts);
        return { ...c, ...artifacts };
      });
      return { ...hostRow, children: enrichedChildren };
    });

    chartArtifactsRef.current = nextArtifacts;
    return data;
  }, [inventoryHierarchy, statsByEntityId, chartDataByEntityId]);

  const expandedState = useMemo<ExpandedState>(() => {
    const state: Record<string, boolean> = {};
    const totalHosts = inventoryHierarchy.hostNames.length;
    for (const hostName of inventoryHierarchy.hostNames) {
      state[`host:${hostName}`] = isHostExpanded(hostName, totalHosts);
    }
    return state;
  }, [inventoryHierarchy, isHostExpanded]);

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
          if (!row.stats) return { value: EMPTY_METRIC, unit: '' };
          return formatAsPercentParts(row.stats.rates.cpuPercent / 100, docker.decimals.cpu);
        },
        getSparklineData: (row) => (row.type === 'container' ? (row.sparklineData?.cpu ?? []) : []),
        getSparklineEntityId: sparklineEntityId,
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
          if (!row.stats) return { value: EMPTY_METRIC, unit: '' };
          return docker.memoryDisplayMode === 'bytes'
            ? formatBytesParts(row.stats.memory_stats.usage, false, docker.decimals.memory)
            : formatAsPercentParts(row.stats.rates.memoryPercent / 100, docker.decimals.memory);
        },
        getSparklineData: (row) => (row.type === 'container' ? (row.sparklineData?.memory ?? []) : []),
        getSparklineEntityId: sparklineEntityId,
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
          if (!row.stats) return { value: EMPTY_METRIC, unit: '' };
          return formatBytesParts(row.stats.rates.blockIoReadBytesPerSec, true, docker.decimals.diskSpeed);
        },
        getSparklineData: (row) => (row.type === 'container' ? (row.sparklineData?.blockRead ?? []) : []),
        getSparklineEntityId: sparklineEntityId,
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
          if (!row.stats) return { value: EMPTY_METRIC, unit: '' };
          return formatBytesParts(row.stats.rates.blockIoWriteBytesPerSec, true, docker.decimals.diskSpeed);
        },
        getSparklineData: (row) => (row.type === 'container' ? (row.sparklineData?.blockWrite ?? []) : []),
        getSparklineEntityId: sparklineEntityId,
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
          if (!row.stats) return { value: EMPTY_METRIC, unit: '' };
          return formatBitsSIUnitsParts(row.stats.rates.networkRxBytesPerSec * 8, true, docker.decimals.networkSpeed);
        },
        getSparklineData: (row) => (row.type === 'container' ? (row.sparklineData?.networkRx ?? []) : []),
        getSparklineEntityId: sparklineEntityId,
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
          if (!row.stats) return { value: EMPTY_METRIC, unit: '' };
          return formatBitsSIUnitsParts(row.stats.rates.networkTxBytesPerSec * 8, true, docker.decimals.networkSpeed);
        },
        getSparklineData: (row) => (row.type === 'container' ? (row.sparklineData?.networkTx ?? []) : []),
        getSparklineEntityId: sparklineEntityId,
        getIsStale: (row) => row.isStale,
      }),
    ],
    [docker.decimals.cpu, docker.decimals.memory, docker.decimals.diskSpeed, docker.decimals.networkSpeed, docker.memoryDisplayMode, memLabel, general.showSparklines, general.useAbbreviatedUnits],
  );

  /** Render container detail panel (charts + logs) for the nested DataTable */
  const renderContainerDetail = useCallback(
    (row: DockerTableRow) => {
      if (row.type !== 'container' || !row.dataPoints) return null;
      const { host, containerId } = row.inventory;
      if (!host || !containerId) return null;
      const entityId = `${host}/${containerId}`;
      return (
        <ContainerDetailPanel
          dataPoints={row.dataPoints}
          containerId={containerId}
          host={host}
          inventory={row.inventory}
          iconSlug={entityIcons[entityId]?.iconSlug ?? null}
          serviceKeyEntity={entityIcons[entityId]?.serviceKeyEntity ?? entityId}
          onIconChange={onIconChange}
        />
      );
    },
    [entityIcons, onIconChange],
  );

  const rowClassName = useCallback((row: DockerTableRow) => {
    if (row.type === 'host') {
      const base = row.isStale ? 'bg-[var(--row-stale-tint)]!' : 'bg-(--level1)!';
      // scroll-mt clears the DataTable's sticky column header (~37px) when scrollIntoView is called
      return `${base} scroll-mt-10`;
    }
    if (row.isStale) {
      return 'bg-[var(--row-stale-tint)]! opacity-70!';
    }
    const { state } = row.inventory;
    if (state !== 'running' && state !== 'restarting') {
      return 'opacity-60!';
    }
    return '';
  }, []);

  const rowAttributes = useCallback((row: DockerTableRow): Record<`data-${string}`, string> => {
    if (row.type === 'host') {
      return { 'data-row-variant': row.isStale ? 'stale' : 'host', 'data-host-id': row.hostName };
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
      <div className="w-full">
        <div className="p-2">
          <p className="text-destructive">
            Error connecting to Docker stats: {error.message}
          </p>
        </div>
      </div>
    );
  }

  if (inventoryError && inventory.size === 0) {
    return (
      <div className="w-full">
        <div className="p-2">
          <p className="text-destructive">
            Error connecting to Docker inventory: {inventoryError.message}
          </p>
        </div>
      </div>
    );
  }

  // Show spinner until both streams are ready: stats SSE (isConnected or hasData)
  // and inventory SSE (isInventoryConnected or inventory has data). Without this guard,
  // the table would render zero rows when stats arrive before inventory.
  if ((!isConnected && !hasData) || (!isInventoryConnected && inventory.size === 0)) {
    return (
      <div className="w-full">
        <div className="flex justify-center p-4">
          <Spinner />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 w-full">
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
    </div>
  );
}

