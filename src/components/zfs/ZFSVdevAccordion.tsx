import { useState } from 'react';
import { Box, Typography } from '@mui/joy';
import { ChevronRight } from 'lucide-react';
import type { VdevStats } from '@/types/zfs';
import { formatBytes, formatAsPercent } from '@/formatters/metrics';
import ZFSMetricCell from './ZFSMetricCell';
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
        style={{
          cursor: hasDisks ? 'pointer' : 'default',
          backgroundColor: '#f5f5f5',
        }}
      >
        <td style={{ paddingLeft: `${indent * 2}rem` }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {hasDisks && (
              <ChevronRight
                size={16}
                style={{
                  transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  transition: 'transform 0.2s',
                }}
              />
            )}
            <Typography level="body-sm">{vdev.data.name}</Typography>
          </Box>
        </td>
        <ZFSMetricCell>
          {vdev.data.capacity.alloc > 0
            ? formatBytes(vdev.data.capacity.alloc, false)
            : '—'}
        </ZFSMetricCell>
        <ZFSMetricCell>{vdev.data.rates.readOpsPerSec.toFixed(0)}</ZFSMetricCell>
        <ZFSMetricCell>{vdev.data.rates.writeOpsPerSec.toFixed(0)}</ZFSMetricCell>
        <ZFSMetricCell>{formatBytes(vdev.data.rates.readBytesPerSec, true)}</ZFSMetricCell>
        <ZFSMetricCell>{formatBytes(vdev.data.rates.writeBytesPerSec, true)}</ZFSMetricCell>
        <ZFSMetricCell>{formatAsPercent(vdev.data.rates.utilizationPercent / 100)}</ZFSMetricCell>
      </tr>

      {expanded && Array.from(vdev.disks.values()).map((disk) => (
        <ZFSDiskRow key={disk.data.id} disk={disk.data} indent={indent + 1} />
      ))}
    </>
  );
}
