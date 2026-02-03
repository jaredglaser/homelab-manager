import { Typography } from '@mui/joy';
import type { ZFSIOStatWithRates } from '@/types/zfs';
import { formatBytes, formatAsPercent } from '@/formatters/metrics';
import ZFSMetricCell from './ZFSMetricCell';

interface ZFSDiskRowProps {
  disk: ZFSIOStatWithRates;
  indent: number;
}

export default function ZFSDiskRow({ disk, indent }: ZFSDiskRowProps) {
  return (
    <tr style={{ backgroundColor: '#fafafa' }}>
      <td style={{ paddingLeft: `${indent * 2}rem` }}>
        <Typography level="body-sm" sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
          {disk.name}
        </Typography>
      </td>
      <ZFSMetricCell>—</ZFSMetricCell>
      <ZFSMetricCell>{disk.rates.readOpsPerSec.toFixed(0)}</ZFSMetricCell>
      <ZFSMetricCell>{disk.rates.writeOpsPerSec.toFixed(0)}</ZFSMetricCell>
      <ZFSMetricCell>{formatBytes(disk.rates.readBytesPerSec, true)}</ZFSMetricCell>
      <ZFSMetricCell>{formatBytes(disk.rates.writeBytesPerSec, true)}</ZFSMetricCell>
      <ZFSMetricCell>{formatAsPercent(disk.rates.utilizationPercent / 100)}</ZFSMetricCell>
    </tr>
  );
}
