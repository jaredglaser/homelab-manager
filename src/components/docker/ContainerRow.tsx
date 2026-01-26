import type { DockerContainer } from '../../types/docker';
import { formatPercent, formatMBps, formatMbps } from '../../formatters/metrics';
import MetricCell from './MetricCell';

interface ContainerRowProps {
  container: DockerContainer;
}

export default function ContainerRow({ container }: ContainerRowProps) {
  return (
    <tr>
      <td>{container.name}</td>
      <MetricCell>{formatPercent(container.cpuUtil)}</MetricCell>
      <MetricCell>{formatPercent(container.ramUtil)}</MetricCell>
      <MetricCell>{formatMBps(container.ioRead)}</MetricCell>
      <MetricCell>{formatMBps(container.ioWrite)}</MetricCell>
      <MetricCell>{formatMbps(container.networkRead)}</MetricCell>
      <MetricCell>{formatMbps(container.networkWrite)}</MetricCell>
      <MetricCell>{formatPercent(container.ioWait)}</MetricCell>
    </tr>
  );
}
