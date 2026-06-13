import { useCallback, useMemo } from 'react';
import type { ColumnDef, ExpandedState } from '@tanstack/react-table';
import { StaleDataAlert } from '@/components/ui/datatable/StaleDataAlert';
import { DataTable, type MetricGroup } from '@/components/ui/datatable/DataTable';
import { metricColumn, nameColumn } from '@/components/ui/datatable/columns';
import { EMPTY_METRIC } from '@/components/ui/datatable/MetricCell';
import type { ZFSStatsRow, ZFSHostHierarchy } from '@/types/zfs';
import { buildZFSHostHierarchy } from '@/lib/utils/zfs-hierarchy-builder';
import { formatBytesParts, formatAsPercentParts } from '@/formatters/metrics';
import { useGeneralSettings, useZfsSettings } from '@/hooks/useSettings';
import ZFSEntityCell from '@/components/zfs/ZFSEntityCell';
import PoolSubTable from '@/components/zfs/subtables/PoolSubTable';
import { buildHostRow } from '@/components/zfs/utils/zfs-row-builders';
import { Spinner } from '@/components/ui/spinner';

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

/** Cell renderer for ZFS entity names, extracted to satisfy component-definition rules */
function ZFSNameCell({ row }: Readonly<{ row: { original: ZFSTableRow; getIsExpanded: () => boolean } }>) {
  const data = row.original;
  return (
    <ZFSEntityCell
      name={data.name}
      entityType={data.type}
      indent={0}
      isExpanded={row.getIsExpanded()}
      canExpand={data.canExpand}
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
  } = useZfsSettings();
  const { general } = useGeneralSettings();

  const hostHierarchy = useMemo<ZFSHostHierarchy>(() => {
    const rows = Array.from(latestByEntity.values());
    return buildZFSHostHierarchy(rows);
  }, [latestByEntity]);

  /** Convert the ZFS hierarchy Maps into a flat host array for DataTable */
  const tableData = useMemo<ZFSTableRow[]>(() => {
    const totalHosts = hostHierarchy.size;
    const sortedHosts = Array.from(hostHierarchy.values()).sort((a, b) =>
      a.hostName.localeCompare(b.hostName),
    );

    return sortedHosts.map((host) => buildHostRow(host, totalHosts));
  }, [hostHierarchy]);

  /** Host-level expansion state only */
  const expandedState = useMemo<ExpandedState>(() => {
    const state: Record<string, boolean> = {};
    for (const hostRow of tableData) {
      if (hostRow.type === 'host' && hostRow.totalHosts != null) {
        state[hostRow.id] = isZfsHostExpanded(hostRow.name, hostRow.totalHosts);
      }
    }
    return state;
  }, [tableData, isZfsHostExpanded]);

  const handleExpandedChange = useCallback(
    (newExpanded: ExpandedState) => {
      if (typeof newExpanded === 'boolean') return;
      const currentExpanded = expandedState as Record<string, boolean>;
      for (const [id, value] of Object.entries(newExpanded)) {
        if (value !== (currentExpanded[id] ?? false) && id.startsWith('host:')) {
          toggleZfsHostExpanded(id.slice(5));
        }
      }
      for (const id of Object.keys(currentExpanded)) {
        if (currentExpanded[id] && !(id in newExpanded) && id.startsWith('host:')) {
          toggleZfsHostExpanded(id.slice(5));
        }
      }
    },
    [expandedState, toggleZfsHostExpanded],
  );

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
      return 'bg-(--level1)!';
    }
    return '';
  }, []);

  /** Host detail panel: a nested DataTable of pool rows */
  const renderDetailPanel = useCallback(
    (row: ZFSTableRow) => {
      if (row.type !== 'host' || !row.children?.length) return null;
      return (
        <PoolSubTable
          pools={row.children}
          columns={columns}
          isPoolExpanded={isPoolExpanded}
          togglePoolExpanded={togglePoolExpanded}
          isVdevExpanded={isVdevExpanded}
          toggleVdevExpanded={toggleVdevExpanded}
        />
      );
    },
    [columns, isPoolExpanded, togglePoolExpanded, isVdevExpanded, toggleVdevExpanded],
  );

  if (error && !hasData) {
    return (
      <div className="w-full">
        <div className="p-2">
          <p className="text-base" color="error">
            Error connecting to ZFS stats: {error.message}
          </p>
        </div>
      </div>
    );
  }

  if (!isConnected && !hasData) {
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
        enableSorting={false}
      />
    </div>
  );
}
