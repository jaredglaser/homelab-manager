import { useEffect, useState } from 'react';
import { Chip, Collapse } from '@mui/material';
import { ChevronRight, Layers } from 'lucide-react';
import type { StackStatusEntry, StackSummary } from '@/types/stacks';
import { STACKS_GRID } from '@/components/stacks/StacksTable';
import SyncStatusBadge from '@/components/stacks/SyncStatusBadge';
import StackDetail from '@/components/stacks/StackDetail';
import { getIconUrl } from '@/lib/utils/icon-resolver';

interface StackRowProps {
  stack: StackSummary;
  expanded: boolean;
  onToggle: () => void;
  statusMap: Map<string, StackStatusEntry>;
}

function formatRelativeTime(isoDate: string | null): string {
  if (!isoDate) return 'Never';
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Per CLAUDE.md gotcha #5: Do not use React.memo on components receiving streaming/frequently-updated data.
// Incorrect memoization can freeze streaming updates.
function ContainerStatusBadge({ statusEntry }: { statusEntry: StackStatusEntry | undefined }) {
  if (!statusEntry) {
    return <span className="text-xs opacity-40">—</span>;
  }

  const total = statusEntry.containers.length;
  const running = statusEntry.containers.filter((c) => c.status === 'running').length;

  let colorClass: string;
  if (total === 0 || running === 0) {
    colorClass = 'text-red-500';
  } else if (running < total) {
    colorClass = 'text-amber-500';
  } else {
    colorClass = 'text-green-500';
  }

  return (
    <span className={`text-xs font-medium ${colorClass}`}>
      {running}/{total} running
    </span>
  );
}

export default function StackRow({ stack, expanded, onToggle, statusMap }: Readonly<StackRowProps>) {
  const [iconError, setIconError] = useState(false);
  const iconUrl = stack.icon ? getIconUrl(stack.icon, '') : null;
  const statusEntry = statusMap.get(`${stack.name}/${stack.host}`);

  /** Reset error state when the icon URL changes */
  useEffect(() => {
    setIconError(false);
  }, [iconUrl]);

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        className={`group ${STACKS_GRID} items-center cursor-pointer border-t border-[var(--mui-palette-divider)] transition-[background-color,box-shadow] duration-150 ${
          expanded
            ? 'bg-[var(--mui-palette-action-hover)]'
            : 'hover:bg-[var(--mui-palette-action-hover)] hover:shadow-[inset_0_0_0_1px_var(--mui-palette-action-selected)]'
        }`}
      >
        {/* Stack name + icon */}
        <div className="px-3 py-2">
          <div className="flex items-center gap-2">
            <ChevronRight
              size={16}
              className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
            />
            {iconUrl && !iconError ? (
              <img
                src={iconUrl}
                alt=""
                className="w-5 h-5 flex-shrink-0"
                onError={() => setIconError(true)}
              />
            ) : (
              <Layers size={18} className="flex-shrink-0 opacity-60" />
            )}
            <span className="font-medium truncate">{stack.name}</span>
            <ContainerStatusBadge statusEntry={statusEntry} />
          </div>
        </div>

        {/* Host */}
        <div className="px-3 py-2">
          <span className="text-sm truncate">{stack.host}</span>
        </div>

        {/* Sync status */}
        <div className="px-3 py-2">
          <SyncStatusBadge status={stack.syncStatus} />
        </div>

        {/* Deploy mode */}
        <div className="px-3 py-2">
          <Chip
            size="small"
            variant="outlined"
            label={stack.deployMode === 'auto' ? 'Auto' : 'Manual'}
            className={stack.deployMode === 'auto'
              ? '!text-[var(--chart-deploy-success)] !border-[var(--chart-deploy-success)]'
              : '!text-[var(--chart-text-muted)] !border-[var(--chart-text-muted)]'
            }
          />
        </div>

        {/* Last deploy */}
        <div className="px-3 py-2">
          <span className="text-sm opacity-70">{formatRelativeTime(stack.lastDeployAt)}</span>
        </div>
      </div>

      <Collapse in={expanded} unmountOnExit>
        <StackDetail
          stackName={stack.name}
          host={stack.host}
          containers={statusEntry?.containers ?? []}
        />
      </Collapse>
    </div>
  );
}
