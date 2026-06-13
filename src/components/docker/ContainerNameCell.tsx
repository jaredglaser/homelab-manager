import { useEffect, useState } from 'react';
import { IconButton } from '@mui/material';
import { ChevronRight } from 'lucide-react';
import { getIconUrl, FALLBACK_ICON_URL } from '@/lib/utils/icon-resolver';
import ContainerStateChip from '@/components/docker/ContainerStateChip';
import { usePulseIndicator } from '@/hooks/usePulseIndicator';
import type { DockerContainerTableRow } from '@/types/docker';

function ContainerNameCell({
  row,
  expanded,
}: Readonly<{
  row: DockerContainerTableRow;
  expanded: boolean;
}>) {
  const { inventory, stats } = row;

  const [iconError, setIconError] = useState(false);

  const iconUrl = getIconUrl(stats?.icon ?? null, inventory.image);

  useEffect(() => {
    setIconError(false);
  }, [iconUrl]);

  const lastChartRow = row.chartData?.at(-1);
  const lastUpdated = lastChartRow ? new Date(lastChartRow.time) : undefined;
  const lastUpdatedMs = lastUpdated?.getTime() ?? 0;
  const { indicatorRef, pingRef, dotRef } = usePulseIndicator(lastUpdatedMs);

  return (
    <>
      <div className="flex items-center gap-2">
        <IconButton size="small" tabIndex={-1}>
          <ChevronRight
            size={16}
            className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
        </IconButton>

        {/* Pulse indicator: for running and restarting containers with data */}
        {(inventory.state === 'running' || inventory.state === 'restarting') && (
          <div
            ref={indicatorRef}
            className="relative w-2 h-2 shrink-0"
            title={lastUpdated ? `Last updated: ${lastUpdated.toLocaleTimeString()}` : 'No data yet'}
          >
            <div
              ref={pingRef}
              className="absolute inset-0 rounded-full transition-opacity duration-200 opacity-0"
              style={{ backgroundColor: 'var(--indicator-active)' }}
            />
            <div
              ref={dotRef}
              className="absolute inset-0 rounded-full transition-colors duration-300"
              style={{ backgroundColor: 'var(--indicator-active)' }}
            />
          </div>
        )}
        {inventory.state !== 'running' && (
          <ContainerStateChip state={inventory.state} />
        )}

        <img
          src={iconError ? FALLBACK_ICON_URL : iconUrl}
          alt=""
          className="w-5 h-5 shrink-0"
          onError={() => setIconError(true)}
        />
        <span className="truncate">{inventory.name}</span>
      </div>
    </>
  );
}

export default ContainerNameCell;
