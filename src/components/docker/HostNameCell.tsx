import { memo } from 'react';
import { Chip } from '@mui/material';
import { ChevronRight, Server, WifiOff } from 'lucide-react';
import type { DockerHostTableRow } from '@/types/docker';

const HostNameCell = memo(function HostNameCell({
  row,
  expanded,
}: Readonly<{
  row: DockerHostTableRow;
  expanded: boolean;
}>) {
  const { children, aggregated: a } = row;
  const hasContainers = children.length > 0;
  const canToggle = hasContainers;

  return (
    <div className="flex items-center gap-2">
      {canToggle && (
        <span className="inline-flex items-center justify-center p-1" aria-hidden="true">
          <ChevronRight
            size={18}
            className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
        </span>
      )}
      <Server size={18} className="shrink-0" />
      {row.isStale && (
        <WifiOff size={16} className="text-(--indicator-late) shrink-0" />
      )}
      <span className="font-bold">{row.hostName}</span>
      {a.staleContainerCount > 0 && !row.isStale && (
        <Chip size="small" variant="filled" color="warning" label={`${a.staleContainerCount} stale`} />
      )}
    </div>
  );
});

export default HostNameCell;
