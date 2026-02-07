import { useCallback } from 'react';
import type { ZFSHierarchy } from '@/types/zfs';
import { buildHierarchy } from '@/lib/utils/zfs-hierarchy-builder';
import ZFSPoolAccordion from './ZFSPoolAccordion';
import StreamingTable, { type ColumnDef } from '../shared-table/StreamingTable';
import type { ZFSStatsFromDB } from '@/lib/transformers/zfs-transformer';

const columns: ColumnDef[] = [
  { label: 'Pool / Device', width: '30%' },
  { label: 'Capacity', width: '14%', align: 'right' },
  { label: 'Read Ops/s', width: '11%', align: 'right' },
  { label: 'Write Ops/s', width: '11%', align: 'right' },
  { label: 'Read', width: '11%', align: 'right' },
  { label: 'Write', width: '11%', align: 'right' },
  { label: 'Utilization', width: '12%', align: 'right' },
];

export default function ZFSPoolsTable() {
  const onData = useCallback(
    (_prev: ZFSHierarchy, cycleStats: ZFSStatsFromDB[]): ZFSHierarchy => {
      return buildHierarchy(cycleStats);
    },
    [],
  );

  const renderRows = useCallback(
    (state: ZFSHierarchy) =>
      Array.from(state.values()).map((pool) => (
        <ZFSPoolAccordion key={pool.data.id} pool={pool} />
      )),
    [],
  );

  return (
    <StreamingTable<ZFSStatsFromDB[], ZFSHierarchy>
      ariaLabel="zfs pools table"
      columns={columns}
      sseUrl="/api/zfs-stats"
      initialState={new Map()}
      onData={onData}
      renderRows={renderRows}
      errorLabel="Error connecting to ZFS stats"
      tableProps={{
        tableLayout: 'fixed',
        '& td:first-child': {
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        },
      }}
    />
  );
}
