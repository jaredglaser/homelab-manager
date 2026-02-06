import { useCallback } from 'react';
import ContainerRow from './ContainerRow';
import { streamDockerStatsFromDB } from '@/data/docker.functions';
import type { ContainerStatsDisplay, DockerStatsFromDB } from '@/types/docker';
import StreamingTable, { type ColumnDef } from '../shared-table/StreamingTable';

const columns: ColumnDef[] = [
  { label: 'Container Name', width: '20%' },
  { label: 'CPU %', align: 'right' },
  { label: 'RAM %', align: 'right' },
  { label: 'Block Read (MB/s)', align: 'right' },
  { label: 'Block Write (MB/s)', align: 'right' },
  { label: 'Network RX (Mbps)', align: 'right' },
  { label: 'Network TX (Mbps)', align: 'right' },
];

type DockerState = Map<string, ContainerStatsDisplay>;

export default function ContainerTable() {
  const onData = useCallback(
    (prev: DockerState, stat: DockerStatsFromDB): DockerState => {
      const next = new Map(prev);
      next.set(stat.id, stat);
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
    <StreamingTable<DockerStatsFromDB, DockerState>
      title="Docker Containers Dashboard"
      ariaLabel="docker containers table"
      columns={columns}
      streamFn={streamDockerStatsFromDB}
      initialState={new Map()}
      onData={onData}
      renderRows={renderRows}
      retry={{ enabled: true }}
      errorLabel="Error streaming Docker stats"
    />
  );
}
