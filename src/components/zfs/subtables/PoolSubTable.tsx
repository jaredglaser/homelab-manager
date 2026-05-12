import { memo, useCallback, useMemo, type ReactNode } from 'react';
import type { ColumnDef, ExpandedState } from '@tanstack/react-table';
import { DataTable } from '@/components/shared-table/DataTable';
import type { ZFSTableRow } from '@/components/zfs/ZFSPoolsTable';
import VdevDiskSubTable from '@/components/zfs/subtables/VdevDiskSubTable';

/**
 * Nested DataTable for pool rows within an expanded host.
 * Each pool with expandable children renders a VdevDiskSubTable via renderDetailPanel.
 */
const PoolSubTable = memo(function PoolSubTable({
  pools,
  columns,
  isPoolExpanded,
  togglePoolExpanded,
  isVdevExpanded,
  toggleVdevExpanded,
}: Readonly<{
  pools: ZFSTableRow[];
  columns: ColumnDef<ZFSTableRow, unknown>[];
  isPoolExpanded: (id: string, totalPools: number) => boolean;
  togglePoolExpanded: (id: string) => void;
  isVdevExpanded: (id: string) => boolean;
  toggleVdevExpanded: (id: string) => void;
}>) {
  const poolExpanded = useMemo<ExpandedState>(() => {
    const state: Record<string, boolean> = {};
    for (const pool of pools) {
      if (pool.canExpand && pool.totalPools != null) {
        state[pool.id] = isPoolExpanded(pool.id, pool.totalPools);
      }
    }
    return state;
  }, [pools, isPoolExpanded]);

  const handlePoolExpandedChange = useCallback(
    (newExpanded: ExpandedState) => {
      if (typeof newExpanded === 'boolean') return;
      const current = poolExpanded as Record<string, boolean>;
      for (const [id, value] of Object.entries(newExpanded)) {
        if (value !== (current[id] ?? false)) {
          togglePoolExpanded(id);
        }
      }
      for (const id of Object.keys(current)) {
        if (current[id] && !(id in newExpanded)) {
          togglePoolExpanded(id);
        }
      }
    },
    [poolExpanded, togglePoolExpanded],
  );

  const renderPoolDetail = useCallback(
    (row: ZFSTableRow): ReactNode => {
      if (!row.canExpand || !row.children?.length) return null;
      return (
        <VdevDiskSubTable
          vdevsAndDisks={row.children}
          columns={columns}
          isVdevExpanded={isVdevExpanded}
          toggleVdevExpanded={toggleVdevExpanded}
        />
      );
    },
    [columns, isVdevExpanded, toggleVdevExpanded],
  );

  return (
    <DataTable
      data={pools}
      columns={columns}
      getRowId={(row) => row.id}
      renderDetailPanel={renderPoolDetail}
      expandedState={poolExpanded}
      onExpandedChange={handlePoolExpandedChange}
      enableSorting={false}
      showHeader={false}
    />
  );
});

export default PoolSubTable;
