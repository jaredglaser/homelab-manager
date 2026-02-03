import { useState } from 'react';
import { Box, Typography } from '@mui/joy';
import { ChevronRight } from 'lucide-react';
import type { VdevStats } from '@/types/zfs';
import ZFSMetricCells from './ZFSMetricCells';
import ZFSDiskRow from './ZFSDiskRow';

interface ZFSVdevAccordionProps {
  vdev: VdevStats;
  indent: number;
}

export default function ZFSVdevAccordion({ vdev, indent }: ZFSVdevAccordionProps) {
  const [expanded, setExpanded] = useState(false);
  const hasDisks = vdev.disks.size > 0;

  return (
    <>
      <tr
        onClick={() => hasDisks && setExpanded(!expanded)}
        style={{ backgroundColor: 'var(--joy-palette-background-level2)' }}
        className={hasDisks ? 'cursor-pointer' : 'cursor-default'}
      >
        <td style={{ paddingLeft: `${indent * 2}rem` }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {hasDisks && (
              <ChevronRight
                size={16}
                className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
              />
            )}
            <Typography level="body-sm">{vdev.data.name}</Typography>
          </Box>
        </td>
        <ZFSMetricCells data={vdev.data} showCapacity={vdev.data.capacity.alloc > 0} />
      </tr>

      {expanded && Array.from(vdev.disks.values()).map((disk) => (
        <ZFSDiskRow key={disk.data.id} disk={disk.data} indent={indent + 1} />
      ))}
    </>
  );
}
