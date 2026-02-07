import type { DockerStatsFromDB } from '@/types/docker';
import { formatAsPercent, formatBytes, formatBitsSIUnits } from '../../formatters/metrics';
import { MetricCell } from '../shared-table';
import { useSettings } from '@/hooks/useSettings';

interface ContainerRowProps {
  container: DockerStatsFromDB;
  indent?: number;
}

export default function ContainerRow({ container, indent }: ContainerRowProps) {
  const { docker } = useSettings();
  const { rates } = container;
  const { decimals } = docker;

  // Convert bytes/sec to MB/s (using binary: 1 MB = 1024 * 1024 bytes)
  const blockReadMBps = rates.blockIoReadBytesPerSec;
  const blockWriteMBps = rates.blockIoWriteBytesPerSec;

  // Convert bytes/sec to Mbps (using decimal: 1 Mbps = 1,000,000 bits/sec)
  const networkRxBps = (rates.networkRxBytesPerSec * 8);
  const networkTxBps = (rates.networkTxBytesPerSec * 8);

  const memoryDisplay = docker.memoryDisplayMode === 'bytes'
    ? formatBytes(container.memory_stats.usage, false, decimals.memory)
    : formatAsPercent(rates.memoryPercent / 100, decimals.memory);

  return (
    <tr>
      <td className={indent ? 'pl-8' : undefined}>{container.name}</td>
      <MetricCell>{formatAsPercent(rates.cpuPercent / 100, decimals.cpu)}</MetricCell>
      <MetricCell>{memoryDisplay}</MetricCell>
      <MetricCell>{formatBytes(blockReadMBps, true, decimals.diskSpeed)}</MetricCell>
      <MetricCell>{formatBytes(blockWriteMBps, true, decimals.diskSpeed)}</MetricCell>
      <MetricCell>{formatBitsSIUnits(networkRxBps * 8, true, decimals.networkSpeed)}</MetricCell>
      <MetricCell>{formatBitsSIUnits(networkTxBps * 8, true, decimals.networkSpeed)}</MetricCell>
    </tr>
  );
}
