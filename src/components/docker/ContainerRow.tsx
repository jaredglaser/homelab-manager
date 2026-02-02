import type { ContainerStatsWithRates } from '../../types/docker';
import { formatAsPercent, formatMBps, formatMbps } from '../../formatters/metrics';
import MetricCell from './MetricCell';

interface ContainerRowProps {
  container: ContainerStatsWithRates;
}

export default function ContainerRow({ container }: ContainerRowProps) {
  const { rates } = container;

  // Convert bytes/sec to MB/s (using binary: 1 MB = 1024 * 1024 bytes)
  const blockReadMBps = rates.blockIoReadBytesPerSec / (1024 * 1024);
  const blockWriteMBps = rates.blockIoWriteBytesPerSec / (1024 * 1024);

  // Convert bytes/sec to Mbps (using decimal: 1 Mbps = 1,000,000 bits/sec)
  const networkRxMbps = (rates.networkRxBytesPerSec * 8) / (1000 * 1000);
  const networkTxMbps = (rates.networkTxBytesPerSec * 8) / (1000 * 1000);

  return (
    <tr>
      <td>{container.name}</td>
      <MetricCell>{formatAsPercent(rates.cpuPercent / 100)}</MetricCell>
      <MetricCell>{formatAsPercent(rates.memoryPercent / 100)}</MetricCell>
      <MetricCell>{formatMBps(blockReadMBps)}</MetricCell>
      <MetricCell>{formatMBps(blockWriteMBps)}</MetricCell>
      <MetricCell>{formatMbps(networkRxMbps)}</MetricCell>
      <MetricCell>{formatMbps(networkTxMbps)}</MetricCell>
    </tr>
  );
}
