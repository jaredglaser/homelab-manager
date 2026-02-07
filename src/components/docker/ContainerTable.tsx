import { useCallback, useMemo } from 'react';
import DockerHostAccordion from './DockerHostAccordion';
import type { DockerStatsFromDB, DockerHierarchy } from '@/types/docker';
import { buildDockerHierarchy } from '@/lib/utils/docker-hierarchy-builder';
import StreamingTable, { type ColumnDef } from '../shared-table/StreamingTable';
import { useSettings } from '@/hooks/useSettings';

export default function ContainerTable() {
  const { docker } = useSettings();

  const columns: ColumnDef[] = useMemo(
    () => [
      { label: 'Host / Container', width: '20%' },
      { label: 'CPU', align: 'right', paddingRight: '4rem' },
      {
        label:
          docker.memoryDisplayMode === 'percentage' ? 'RAM %' : 'RAM',
        align: 'right',
        paddingRight: '4rem',
      },
      { label: 'Disk Read', align: 'right', paddingRight: '4rem' },
      { label: 'Disk Write', align: 'right', paddingRight: '4rem' },
      { label: 'Net RX', align: 'right', paddingRight: '4rem' },
      { label: 'Net TX', align: 'right', paddingRight: '4rem' },
    ],
    [docker.memoryDisplayMode],
  );

  const onData = useCallback(
    (_prev: DockerHierarchy, stats: DockerStatsFromDB[]): DockerHierarchy => {
      return buildDockerHierarchy(stats);
    },
    [],
  );

  const renderRows = useCallback(
    (state: DockerHierarchy) => {
      const totalHosts = state.size;
      return Array.from(state.values()).map((hostStats) => (
        <DockerHostAccordion
          key={hostStats.hostName}
          host={hostStats}
          totalHosts={totalHosts}
        />
      ));
    },
    [],
  );

  return (
    <StreamingTable<DockerStatsFromDB[], DockerHierarchy>
      ariaLabel="docker containers table"
      columns={columns}
      sseUrl="/api/docker-stats"
      initialState={new Map()}
      onData={onData}
      renderRows={renderRows}
      errorLabel="Error connecting to Docker stats"
      minWidth="800px"
    />
  );
}
