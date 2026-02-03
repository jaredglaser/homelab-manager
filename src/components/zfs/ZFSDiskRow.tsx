import { Typography } from '@mui/joy';
import type { ZFSIOStatWithRates } from '@/types/zfs';
import { formatBytes, formatAsPercent } from '@/formatters/metrics';
import { MetricCell } from '../shared-table';

interface ZFSDiskRowProps {
  disk: ZFSIOStatWithRates;
  indent: number;
}

export default function ZFSDiskRow({ disk, indent }: ZFSDiskRowProps) {
  return (
    <tr className="bg-row-disk">
      <td style={{ paddingLeft: `${indent * 2}rem` }}>
        <Typography level="body-sm" sx={{ fontFamily: 'code', fontSize: '0.75rem' }}>
          {disk.name}
        </Typography>
      </td>
      <MetricCell>—</MetricCell>
      <MetricCell>{disk.rates.readOpsPerSec.toFixed(0)}</MetricCell>
      <MetricCell>{disk.rates.writeOpsPerSec.toFixed(0)}</MetricCell>
      <MetricCell>{formatBytes(disk.rates.readBytesPerSec, true)}</MetricCell>
      <MetricCell>{formatBytes(disk.rates.writeBytesPerSec, true)}</MetricCell>
      <MetricCell>{formatAsPercent(disk.rates.utilizationPercent / 100)}</MetricCell>
    </tr>
  );
}
