import Table from '@mui/joy/Table';
import type { DockerContainer } from '../../types/docker';
import ContainerRow from './ContainerRow';

interface ContainerTableProps {
  containers: DockerContainer[];
}

export default function ContainerTable({ containers }: ContainerTableProps) {
  return (
    <Table aria-label="docker containers table" sx={{ '& thead th': { fontWeight: 600 } }}>
      <thead>
        <tr>
          <th style={{ width: '20%' }}>Container Name</th>
          <th style={{ textAlign: 'right' }}>CPU %</th>
          <th style={{ textAlign: 'right' }}>RAM %</th>
          <th style={{ textAlign: 'right' }}>IO Read (MB/s)</th>
          <th style={{ textAlign: 'right' }}>IO Write (MB/s)</th>
          <th style={{ textAlign: 'right' }}>Network Read (Mbps)</th>
          <th style={{ textAlign: 'right' }}>Network Write (Mbps)</th>
          <th style={{ textAlign: 'right' }}>IO Wait %</th>
        </tr>
      </thead>
      <tbody>
        {containers.map((container) => (
          <ContainerRow key={container.name} container={container} />
        ))}
      </tbody>
    </Table>
  );
}
