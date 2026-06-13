import { memo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from '@/components/ui/datatable/DataTable';
import type { ZFSTableRow } from '@/components/zfs/ZFSPoolsTable';

/**
 * Leaf-level DataTable for disk rows within an expanded vdev.
 * No expansion, just renders disk rows.
 */
const DiskSubTable = memo(function DiskSubTable({
  disks,
  columns,
}: Readonly<{
  disks: ZFSTableRow[];
  columns: ColumnDef<ZFSTableRow, unknown>[];
}>) {
  return (
    <DataTable
      data={disks}
      columns={columns}
      getRowId={(row) => row.id}
      enableSorting={false}
      showHeader={false}
    />
  );
});

export default DiskSubTable;
