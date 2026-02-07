import { Box, Chip, Tooltip, Typography } from '@mui/joy';
import { ChevronRight } from 'lucide-react';
import type { PoolStats } from '@/types/zfs';
import ZFSMetricCells from './ZFSMetricCells';
import ZFSVdevAccordion from './ZFSVdevAccordion';
import ZFSDiskRow from './ZFSDiskRow';
import { useSettings } from '@/hooks/useSettings';

interface ZFSPoolAccordionProps {
  pool: PoolStats;
  totalPools: number;
}

export default function ZFSPoolAccordion({ pool, totalPools }: ZFSPoolAccordionProps) {
  const { isPoolExpanded, togglePoolExpanded } = useSettings();
  const vdevs = Array.from(pool.vdevs.values());
  const disks = Array.from(pool.individualDisks.values());
  const expanded = isPoolExpanded(pool.data.name, totalPools);

  const handleToggle = () => {
    if (totalPools > 1) {
      togglePoolExpanded(pool.data.name);
    }
  };

  const singleVdev = vdevs.length === 1 && disks.length === 0;
  const isSingleDiskPool =
    (singleVdev && vdevs[0].disks.size <= 1) ||
    (vdevs.length === 0 && disks.length === 1);
  const isSingleVdevMultiDisk = singleVdev && vdevs[0].disks.size > 1;

  const badgeLabel = isSingleDiskPool
    ? 'single disk'
    : singleVdev
      ? vdevs[0].data.name
      : null;

  const badgeTooltip = isSingleDiskPool
    ? singleVdev
      ? Array.from(vdevs[0].disks.values())[0]?.data.name ?? vdevs[0].data.name
      : disks[0]?.data.name
    : null;

  // Scenario A: single disk pool — plain row, no accordion
  if (isSingleDiskPool) {
    return (
      <tr>
        <td>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography fontWeight="bold">{pool.data.name}</Typography>
            {badgeLabel && (
              <Tooltip  title={badgeTooltip} arrow placement="bottom-end">
                <Chip size="sm" variant="soft">{badgeLabel}</Chip>
              </Tooltip>
            )}
          </Box>
        </td>
        <ZFSMetricCells data={pool.data} />
      </tr>
    );
  }

  // Scenario B: single vdev, multiple disks — pool accordion, no vdev accordion
  if (isSingleVdevMultiDisk) {
    const vdevDisks = Array.from(vdevs[0].disks.values());
    return (
      <>
        <tr
          onClick={handleToggle}
          className={totalPools > 1 ? 'cursor-pointer' : 'cursor-default'}
        >
          <td>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              {totalPools > 1 && (
                <ChevronRight
                  size={18}
                  className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
                />
              )}
              <Typography fontWeight="bold">{pool.data.name}</Typography>
              {badgeLabel && <Chip size="sm" variant="soft">{badgeLabel}</Chip>}
            </Box>
          </td>
          <ZFSMetricCells data={pool.data} />
        </tr>
        {expanded &&
          vdevDisks.map((disk) => (
            <ZFSDiskRow key={disk.data.id} disk={disk.data} indent={1} />
          ))}
      </>
    );
  }

  // Scenario C: multiple vdevs — current behavior
  const hasChildren = vdevs.length > 0 || disks.length > 0;

  return (
    <>
      <tr
        onClick={() => hasChildren && handleToggle()}
        className={hasChildren && totalPools > 1 ? 'cursor-pointer' : 'cursor-default'}
      >
        <td>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {hasChildren && totalPools > 1 && (
              <ChevronRight
                size={18}
                className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
              />
            )}
            <Typography fontWeight="bold">{pool.data.name}</Typography>
          </Box>
        </td>
        <ZFSMetricCells data={pool.data} />
      </tr>

      {expanded && (
        <>
          {vdevs.map((vdev) => (
            <ZFSVdevAccordion key={vdev.data.id} vdev={vdev} indent={1} />
          ))}
          {disks.map((disk) => (
            <ZFSDiskRow key={disk.data.id} disk={disk.data} indent={1} />
          ))}
        </>
      )}
    </>
  );
}
