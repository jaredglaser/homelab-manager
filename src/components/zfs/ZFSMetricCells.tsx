import type { ZFSIOStatWithRates } from '@/types/zfs';
import { formatBytes, formatAsPercent } from '@/formatters/metrics';
import { MetricCell } from '../shared-table';

interface ZFSMetricCellsProps {
  data: ZFSIOStatWithRates;
  showCapacity?: boolean;
}

export default function ZFSMetricCells({ data, showCapacity = true }: ZFSMetricCellsProps) {
  return (
    <>
      <MetricCell>
        {showCapacity && data.capacity.alloc > 0
          ? formatBytes(data.capacity.alloc, false)
          : '—'}
      </MetricCell>
      <MetricCell>{data.rates.readOpsPerSec.toFixed(0)}</MetricCell>
      <MetricCell>{data.rates.writeOpsPerSec.toFixed(0)}</MetricCell>
      <MetricCell>{formatBytes(data.rates.readBytesPerSec, true)}</MetricCell>
      <MetricCell>{formatBytes(data.rates.writeBytesPerSec, true)}</MetricCell>
      <MetricCell>{formatAsPercent(data.rates.utilizationPercent / 100)}</MetricCell>
    </>
  );
}
