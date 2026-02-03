import type { ContainerStatsWithRates } from '../../types/docker';
import { formatAsPercent, formatBytes, formatBitsSIUnits } from '../../formatters/metrics';
import { MetricCell } from '../shared-table';

interface ContainerRowProps {
  container: ContainerStatsWithRates;
}

export default function ContainerRow({ container }: ContainerRowProps) {
  const { rates } = container;

  // Convert bytes/sec to MB/s (using binary: 1 MB = 1024 * 1024 bytes)
  const blockReadMBps = rates.blockIoReadBytesPerSec;
  const blockWriteMBps = rates.blockIoWriteBytesPerSec;

  // Convert bytes/sec to Mbps (using decimal: 1 Mbps = 1,000,000 bits/sec)
  const networkRxBps = (rates.networkRxBytesPerSec * 8);
  const networkTxBps = (rates.networkTxBytesPerSec * 8);

  return (
    <tr>
      <td>{container.name}</td>
      <MetricCell>{formatAsPercent(rates.cpuPercent / 100)}</MetricCell>
      <MetricCell>{formatAsPercent(rates.memoryPercent / 100)}</MetricCell>
      <MetricCell>{formatBytes(blockReadMBps, true)}</MetricCell>
      <MetricCell>{formatBytes(blockWriteMBps, true)}</MetricCell>
      <MetricCell>{formatBitsSIUnits(networkRxBps * 8, true)}</MetricCell>
      <MetricCell>{formatBitsSIUnits(networkTxBps * 8, true)}</MetricCell>
    </tr>
  );
}
