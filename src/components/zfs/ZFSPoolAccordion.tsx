import { useState } from 'react';
import { Box, Typography } from '@mui/joy';
import { ChevronRight } from 'lucide-react';
import type { PoolStats } from '@/types/zfs';
import { formatBytes, formatAsPercent } from '@/formatters/metrics';
import ZFSMetricCell from './ZFSMetricCell';
import ZFSVdevAccordion from './ZFSVdevAccordion';
import ZFSDiskRow from './ZFSDiskRow';

interface ZFSPoolAccordionProps {
  pool: PoolStats;
}

export default function ZFSPoolAccordion({ pool }: ZFSPoolAccordionProps) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = pool.vdevs.size > 0 || pool.individualDisks.size > 0;

  return (
    <>
      <tr
        onClick={() => hasChildren && setExpanded(!expanded)}
        style={{
          cursor: hasChildren ? 'pointer' : 'default',
        }}
      >
        <td>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {hasChildren && (
              <ChevronRight
                size={18}
                style={{
                  transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  transition: 'transform 0.2s',
                }}
              />
            )}
            <Typography fontWeight="bold">{pool.data.name}</Typography>
          </Box>
        </td>
        <ZFSMetricCell>{formatBytes(pool.data.capacity.alloc, false)}</ZFSMetricCell>
        <ZFSMetricCell>{pool.data.rates.readOpsPerSec.toFixed(0)}</ZFSMetricCell>
        <ZFSMetricCell>{pool.data.rates.writeOpsPerSec.toFixed(0)}</ZFSMetricCell>
        <ZFSMetricCell>{formatBytes(pool.data.rates.readBytesPerSec, true)}</ZFSMetricCell>
        <ZFSMetricCell>{formatBytes(pool.data.rates.writeBytesPerSec, true)}</ZFSMetricCell>
        <ZFSMetricCell>{formatAsPercent(pool.data.rates.utilizationPercent / 100)}</ZFSMetricCell>
      </tr>

      {expanded && (
        <>
          {Array.from(pool.vdevs.values()).map((vdev) => (
            <ZFSVdevAccordion key={vdev.data.id} vdev={vdev} indent={1} />
          ))}
          {Array.from(pool.individualDisks.values()).map((disk) => (
            <ZFSDiskRow key={disk.data.id} disk={disk.data} indent={1} />
          ))}
        </>
      )}
    </>
  );
}
