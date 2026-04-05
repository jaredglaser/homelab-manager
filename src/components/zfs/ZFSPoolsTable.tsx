import { useCallback, useMemo } from 'react';
import type { ColumnDef, ExpandedState } from '@tanstack/react-table';
import { Box, CircularProgress, Typography } from '@mui/material';
import { StaleDataAlert } from '@/components/shared-table/StaleDataAlert';
import { DataTable, type MetricGroup } from '@/components/shared-table/DataTable';
import { metricColumn, nameColumn } from '@/components/shared-table/columns';
import { EMPTY_METRIC } from '@/components/shared-table';
import type { ZFSStatsRow, ZFSHostHierarchy, ZFSHostStats, PoolStats, VdevStats } from '@/types/zfs';
import { buildZFSHostHierarchy } from '@/lib/utils/zfs-hierarchy-builder';
import { formatBytesParts, formatAsPercentParts } from '@/formatters/metrics';
import { useSettings } from '@/hooks/useSettings';
import ZFSEntityCell from '@/components/zfs/ZFSEntityCell';

/** Flattened row model for the DataTable tree structure */
export interface ZFSTableRow {
  type: 'host' | 'pool' | 'vdev' | 'disk';
  id: string;
  name: string;
  indent: number;
  /** Metric data */
  capacityAlloc?: number;
  capacityFree?: number;
  readOpsPerSec?: number;
  writeOpsPerSec?: number;
  readBytesPerSec?: number;
  writeBytesPerSec?: number;
  utilizationPercent?: number;
  /** Display helpers */
  badge?: { label: string; tooltip?: string };
  canExpand: boolean;
  /** Counts needed for auto-expand logic */
  totalHosts?: number;
  totalPools?: number;
  /** Tree children */
  children?: ZFSTableRow[];
}

const METRIC_GROUPS: MetricGroup[] = [
  { label: 'Capacity', columnIds: ['capacity'] },
  { label: 'Ops', columnIds: ['readOps', 'writeOps'] },
  { label: 'Throughput', columnIds: ['readBytes', 'writeBytes', 'utilization'] },
];

/** Cell renderer for ZFS entity names — extracted to satisfy component-definition rules */
function ZFSNameCell({ row }: Readonly<{ row: { original: ZFSTableRow; getIsExpanded: () => boolean; getToggleExpandedHandler: () => () => void } }>) {
  const data = row.original;
  return (
    <ZFSEntityCell
      name={data.name}
      entityType={data.type}
      indent={data.indent}
      isExpanded={row.getIsExpanded()}
      canExpand={data.canExpand}
      onToggle={row.getToggleExpandedHandler()}
      badge={data.badge}
    />
  );
}

interface ZFSPoolsTableProps {
  latestByEntity: Map<string, ZFSStatsRow>;
  hasData: boolean;
  isConnected: boolean;
  error: Error | null;
  isStale: boolean;
}

export default function ZFSPoolsTable({
  latestByEntity,
  hasData,
  isConnected,
  error,
  isStale,
}: Readonly<ZFSPoolsTableProps>) {
  const {
    isZfsHostExpanded,
    toggleZfsHostExpanded,
    isPoolExpanded,
    togglePoolExpanded,
    isVdevExpanded,
    toggleVdevExpanded,
    zfs,
    general,
  } = useSettings();

  const hostHierarchy = useMemo<ZFSHostHierarchy>(() => {
    const rows = Array.from(latestByEntity.values());
    return buildZFSHostHierarchy(rows);
  }, [latestByEntity]);

  /** Convert the ZFS hierarchy Maps into a tree array for DataTable */
  const tableData = useMemo<ZFSTableRow[]>(() => {
    const totalHosts = hostHierarchy.size;
    const sortedHosts = Array.from(hostHierarchy.values()).sort((a, b) =>
      a.hostName.localeCompare(b.hostName),
    );

    return sortedHosts.map((host) => buildHostRow(host, totalHosts));
  }, [hostHierarchy]);

  /** Map settings expansion state to TanStack Table ExpandedState */
  const expandedState = useMemo<ExpandedState>(() => {
    const state: Record<string, boolean> = {};

    function walk(rows: ZFSTableRow[]) {
      for (const row of rows) {
        if (row.type === 'host' && row.totalHosts != null) {
          state[row.id] = isZfsHostExpanded(row.name, row.totalHosts);
        } else if (row.type === 'pool' && row.totalPools != null) {
          state[row.id] = isPoolExpanded(row.id, row.totalPools);
        } else if (row.type === 'vdev') {
          state[row.id] = isVdevExpanded(row.id);
        }
        if (row.children) walk(row.children);
      }
    }

    walk(tableData);
    return state;
  }, [tableData, isZfsHostExpanded, isPoolExpanded, isVdevExpanded]);

  const handleExpandedChange = useCallback(
    (newExpanded: ExpandedState) => {
      if (typeof newExpanded === 'boolean') return;

      const currentExpanded = expandedState as Record<string, boolean>;

      for (const [id, value] of Object.entries(newExpanded)) {
        const wasExpanded = currentExpanded[id] ?? false;
        if (value !== wasExpanded) {
          dispatchToggle(id);
        }
      }

      for (const id of Object.keys(currentExpanded)) {
        if (currentExpanded[id] && !(id in newExpanded)) {
          dispatchToggle(id);
        }
      }
    },
    [expandedState, toggleZfsHostExpanded, togglePoolExpanded, toggleVdevExpanded],
  );

  function dispatchToggle(id: string) {
    if (id.startsWith('host:')) {
      toggleZfsHostExpanded(id.slice(5));
    } else if (id.startsWith('vdev:')) {
      toggleVdevExpanded(id);
    } else {
      // Pool IDs are the host-prefixed entity id (e.g. "myhost/tank")
      togglePoolExpanded(id);
    }
  }

  const columns = useMemo<ColumnDef<ZFSTableRow, unknown>[]>(
    () => [
      nameColumn<ZFSTableRow>({
        getLabel: (row) => row.name,
        size: 300,
        cell: ZFSNameCell,
      }),
      metricColumn<ZFSTableRow>({
        id: 'capacity',
        header: 'Capacity',
        showSparklines: general.showSparklines,
        useAbbreviatedUnits: general.useAbbreviatedUnits,
        getValue: (row) => {
          const alloc = row.capacityAlloc ?? 0;
          const free = row.capacityFree ?? 0;
          const total = alloc + free;
          if (total <= 0) return { value: EMPTY_METRIC, unit: '' };
          return formatBytesParts(total, false);
        },
      }),
      metricColumn<ZFSTableRow>({
        id: 'readOps',
        header: 'Read Ops/s',
        showSparklines: general.showSparklines,
        useAbbreviatedUnits: general.useAbbreviatedUnits,
        getValue: (row) => {
          const v = row.readOpsPerSec;
          if (v == null) return { value: EMPTY_METRIC, unit: '' };
          return { value: v.toFixed(0), unit: 'ops/s' };
        },
      }),
      metricColumn<ZFSTableRow>({
        id: 'writeOps',
        header: 'Write Ops/s',
        showSparklines: general.showSparklines,
        useAbbreviatedUnits: general.useAbbreviatedUnits,
        getValue: (row) => {
          const v = row.writeOpsPerSec;
          if (v == null) return { value: EMPTY_METRIC, unit: '' };
          return { value: v.toFixed(0), unit: 'ops/s' };
        },
      }),
      metricColumn<ZFSTableRow>({
        id: 'readBytes',
        header: 'Read',
        hasDecimals: zfs.decimals.diskSpeed,
        showSparklines: general.showSparklines,
        useAbbreviatedUnits: general.useAbbreviatedUnits,
        getValue: (row) => {
          const v = row.readBytesPerSec;
          if (v == null) return { value: EMPTY_METRIC, unit: '' };
          return formatBytesParts(v, true, zfs.decimals.diskSpeed);
        },
      }),
      metricColumn<ZFSTableRow>({
        id: 'writeBytes',
        header: 'Write',
        hasDecimals: zfs.decimals.diskSpeed,
        showSparklines: general.showSparklines,
        useAbbreviatedUnits: general.useAbbreviatedUnits,
        getValue: (row) => {
          const v = row.writeBytesPerSec;
          if (v == null) return { value: EMPTY_METRIC, unit: '' };
          return formatBytesParts(v, true, zfs.decimals.diskSpeed);
        },
      }),
      metricColumn<ZFSTableRow>({
        id: 'utilization',
        header: 'Utilization',
        hasDecimals: zfs.decimals.diskSpeed,
        showSparklines: general.showSparklines,
        useAbbreviatedUnits: general.useAbbreviatedUnits,
        getValue: (row) => {
          const v = row.utilizationPercent;
          if (v == null) return { value: EMPTY_METRIC, unit: '' };
          return formatAsPercentParts(v / 100, zfs.decimals.diskSpeed);
        },
      }),
    ],
    [zfs.decimals.diskSpeed, general.showSparklines, general.useAbbreviatedUnits],
  );

  const rowClassName = useCallback((row: ZFSTableRow) => {
    if (row.type === 'host') {
      return '!bg-[var(--mui-palette-background-level1)]';
    }
    return '';
  }, []);

  if (error && !hasData) {
    return (
      <Box className="w-full">
        <Box className="p-2">
          <Typography color="error">
            Error connecting to ZFS stats: {error.message}
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
        getSubRows={(row) => row.children}
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
 * Build a host-level tree row with pool children from the ZFS hierarchy.
 */
function buildHostRow(host: ZFSHostStats, totalHosts: number): ZFSTableRow {
  const a = host.aggregated;
  const totalPools = host.pools.size;
  const sortedPools = Array.from(host.pools.values()).sort((a, b) =>
    a.data.name.localeCompare(b.data.name),
  );

  const children = sortedPools.map((pool) => buildPoolRow(pool, totalPools));

  return {
    type: 'host',
    id: `host:${host.hostName}`,
    name: host.hostName,
    indent: 0,
    capacityAlloc: a.capacityAlloc,
    capacityFree: a.capacityFree,
    readOpsPerSec: a.readOpsPerSec,
    writeOpsPerSec: a.writeOpsPerSec,
    readBytesPerSec: a.readBytesPerSec,
    writeBytesPerSec: a.writeBytesPerSec,
    badge: { label: `${a.poolCount} pool${a.poolCount === 1 ? '' : 's'}` },
    canExpand: totalHosts > 1 && totalPools > 0,
    totalHosts,
    children,
  };
}

/**
 * Build a pool-level tree row with vdev/disk children.
 * Preserves the original table's badge and vdev-skip logic.
 */
function buildPoolRow(pool: PoolStats, totalPools: number): ZFSTableRow {
  const vdevs = Array.from(pool.vdevs.values()).sort((a, b) =>
    a.data.name.localeCompare(b.data.name),
  );
  const individualDisks = Array.from(pool.individualDisks.values()).sort((a, b) =>
    a.data.name.localeCompare(b.data.name),
  );

  const singleVdev = vdevs.length === 1 && individualDisks.length === 0;
  const isSingleDiskPool =
    (singleVdev && vdevs[0].disks.size <= 1) ||
    (vdevs.length === 0 && individualDisks.length === 1);
  const isSingleVdevMultiDisk = singleVdev && vdevs[0].disks.size > 1;

  let badge: { label: string; tooltip?: string } | undefined;
  if (isSingleDiskPool) {
    const tooltipName = singleVdev
      ? Array.from(vdevs[0].disks.values())[0]?.data.name ?? vdevs[0].data.name
      : individualDisks[0]?.data.name;
    badge = { label: 'single disk', tooltip: tooltipName };
  } else if (singleVdev) {
    badge = { label: vdevs[0].data.name };
  }

  const expandable = !isSingleDiskPool;
  let children: ZFSTableRow[] | undefined;

  if (expandable) {
    if (isSingleVdevMultiDisk) {
      // Skip the vdev level, show disks directly under pool
      const vdevDisks = Array.from(vdevs[0].disks.values()).sort((a, b) =>
        a.data.name.localeCompare(b.data.name),
      );
      children = vdevDisks.map((disk) => buildDiskRow(disk.data.id, disk.data.name, disk.data, 1));
    } else {
      const vdevChildren = vdevs.map((vdev) => buildVdevRow(vdev));
      const diskChildren = individualDisks.map((disk) =>
        buildDiskRow(disk.data.id, disk.data.name, disk.data, 1),
      );
      children = [...vdevChildren, ...diskChildren];
    }
  }

  return {
    type: 'pool',
    id: pool.data.id,
    name: pool.data.name,
    indent: 0,
    capacityAlloc: pool.data.capacity.alloc,
    capacityFree: pool.data.capacity.free,
    readOpsPerSec: pool.data.rates.readOpsPerSec,
    writeOpsPerSec: pool.data.rates.writeOpsPerSec,
    readBytesPerSec: pool.data.rates.readBytesPerSec,
    writeBytesPerSec: pool.data.rates.writeBytesPerSec,
    utilizationPercent: pool.data.rates.utilizationPercent,
    badge,
    canExpand: expandable,
    totalPools,
    children,
  };
}

/**
 * Build a vdev-level tree row with disk children.
 */
function buildVdevRow(vdev: VdevStats): ZFSTableRow {
  const sortedDisks = Array.from(vdev.disks.values()).sort((a, b) =>
    a.data.name.localeCompare(b.data.name),
  );

  const hasDisks = sortedDisks.length > 0;
  const children = hasDisks
    ? sortedDisks.map((disk) => buildDiskRow(disk.data.id, disk.data.name, disk.data, 2))
    : undefined;

  return {
    type: 'vdev',
    id: `vdev:${vdev.data.id}`,
    name: vdev.data.name,
    indent: 1,
    capacityAlloc: vdev.data.capacity.alloc > 0 ? vdev.data.capacity.alloc : undefined,
    capacityFree: vdev.data.capacity.alloc > 0 ? vdev.data.capacity.free : undefined,
    readOpsPerSec: vdev.data.rates.readOpsPerSec,
    writeOpsPerSec: vdev.data.rates.writeOpsPerSec,
    readBytesPerSec: vdev.data.rates.readBytesPerSec,
    writeBytesPerSec: vdev.data.rates.writeBytesPerSec,
    utilizationPercent: vdev.data.rates.utilizationPercent,
    canExpand: hasDisks,
    children,
  };
}

/**
 * Build a disk leaf row (no children).
 */
function buildDiskRow(
  id: string,
  name: string,
  data: { rates: { readOpsPerSec: number; writeOpsPerSec: number; readBytesPerSec: number; writeBytesPerSec: number; utilizationPercent: number } },
  indent: number,
): ZFSTableRow {
  return {
    type: 'disk',
    id: `disk:${id}`,
    name,
    indent,
    readOpsPerSec: data.rates.readOpsPerSec,
    writeOpsPerSec: data.rates.writeOpsPerSec,
    readBytesPerSec: data.rates.readBytesPerSec,
    writeBytesPerSec: data.rates.writeBytesPerSec,
    utilizationPercent: data.rates.utilizationPercent,
    canExpand: false,
  };
}
