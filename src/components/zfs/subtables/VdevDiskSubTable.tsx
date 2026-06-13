import { memo, useCallback, useMemo, type ReactNode } from 'react';
import type { ColumnDef, ExpandedState } from '@tanstack/react-table';
import { DataTable } from '@/components/ui/datatable/DataTable';
import type { ZFSTableRow } from '@/components/zfs/ZFSPoolsTable';
import DiskSubTable from '@/components/zfs/subtables/DiskSubTable';

/**
 * Nested DataTable for vdev and disk rows within an expanded pool.
 * Vdevs with disk children render a DiskSubTable via renderDetailPanel.
 */
const VdevDiskSubTable = memo(function VdevDiskSubTable({
  vdevsAndDisks,
  columns,
  isVdevExpanded,
  toggleVdevExpanded,
}: Readonly<{
  vdevsAndDisks: ZFSTableRow[];
  columns: ColumnDef<ZFSTableRow, unknown>[];
  isVdevExpanded: (id: string) => boolean;
  toggleVdevExpanded: (id: string) => void;
}>) {
  const vdevExpanded = useMemo<ExpandedState>(() => {
    const state: Record<string, boolean> = {};
    for (const row of vdevsAndDisks) {
      if (row.type === 'vdev' && row.canExpand) {
        state[row.id] = isVdevExpanded(row.id);
      }
    }
    return state;
  }, [vdevsAndDisks, isVdevExpanded]);

  const handleVdevExpandedChange = useCallback(
    (newExpanded: ExpandedState) => {
      if (typeof newExpanded === 'boolean') return;
      const current = vdevExpanded as Record<string, boolean>;
      for (const [id, value] of Object.entries(newExpanded)) {
        if (value !== (current[id] ?? false)) {
          toggleVdevExpanded(id);
        }
      }
      for (const id of Object.keys(current)) {
        if (current[id] && !(id in newExpanded)) {
          toggleVdevExpanded(id);
        }
      }
    },
    [vdevExpanded, toggleVdevExpanded],
  );

  const renderVdevDetail = useCallback(
    (row: ZFSTableRow): ReactNode => {
      if (row.type !== 'vdev' || !row.canExpand || !row.children?.length) return null;
      return (
        <DiskSubTable
          disks={row.children}
          columns={columns}
        />
      );
    },
    [columns],
  );

  return (
    <DataTable
      data={vdevsAndDisks}
      columns={columns}
      getRowId={(row) => row.id}
      renderDetailPanel={renderVdevDetail}
      expandedState={vdevExpanded}
      onExpandedChange={handleVdevExpandedChange}
      enableSorting={false}
      showHeader={false}
    />
  );
});

export default VdevDiskSubTable;
