import { useCallback, useMemo } from 'react';
import ContainerRow from './ContainerRow';
import type { DockerStatsFromDB } from '@/types/docker';
import StreamingTable, { type ColumnDef } from '../shared-table/StreamingTable';
import { useSettings } from '@/hooks/useSettings';

type DockerState = Map<string, DockerStatsFromDB>;

export default function ContainerTable() {
  const { docker } = useSettings();

  const columns: ColumnDef[] = useMemo(
    () => [
      { label: 'Container Name', width: '20%' },
      { label: 'CPU %', align: 'right' },
      {
        label:
          docker.memoryDisplayMode === 'percentage' ? 'RAM %' : 'RAM',
        align: 'right',
      },
      { label: 'Block Read (MB/s)', align: 'right' },
      { label: 'Block Write (MB/s)', align: 'right' },
      { label: 'Network RX (Mbps)', align: 'right' },
      { label: 'Network TX (Mbps)', align: 'right' },
    ],
    [docker.memoryDisplayMode],
  );

  const onData = useCallback(
    (_prev: DockerState, stats: DockerStatsFromDB[]): DockerState => {
      const next = new Map<string, DockerStatsFromDB>();
      for (const stat of stats) {
        next.set(stat.id, stat);
      }
      return next;
    },
    [],
  );

  const renderRows = useCallback(
    (state: DockerState) =>
      Array.from(state.values()).map((containerStat) => (
        <ContainerRow key={containerStat.id} container={containerStat} />
      )),
    [],
  );

  return (
    <StreamingTable<DockerStatsFromDB[], DockerState>
      ariaLabel="docker containers table"
      columns={columns}
      sseUrl="/api/docker-stats"
      initialState={new Map()}
      onData={onData}
      renderRows={renderRows}
      errorLabel="Error connecting to Docker stats"
    />
  );
}
