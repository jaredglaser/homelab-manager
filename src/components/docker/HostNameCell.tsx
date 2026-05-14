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
  const { totalHosts, children, aggregated: a } = row;
  const hasContainers = children.length > 0;
  const canToggle = hasContainers && totalHosts > 1;

  return (
    <div className="flex items-center gap-2">
      {canToggle && (
        <ChevronRight
          size={18}
          className={`shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />
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
