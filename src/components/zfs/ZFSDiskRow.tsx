import { Typography } from '@mui/joy';
import type { ZFSIOStatWithRates } from '@/types/zfs';
import ZFSMetricCells from './ZFSMetricCells';

interface ZFSDiskRowProps {
  disk: ZFSIOStatWithRates;
  indent: number;
}

export default function ZFSDiskRow({ disk, indent }: ZFSDiskRowProps) {
  return (
    <tr style={{ backgroundColor: 'var(--joy-palette-background-level1)' }}>
      <td style={{ paddingLeft: `${indent * 2}rem` }}>
        <Typography level="body-sm" sx={{ fontFamily: 'code', fontSize: '0.75rem' }}>
          {disk.name}
        </Typography>
      </td>
      <ZFSMetricCells data={disk} showCapacity={false} />
    </tr>
  );
}
