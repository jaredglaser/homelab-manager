import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { Skeleton, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import { HelpCircle } from 'lucide-react';
import type { StackDeployRecord, DeployStatus } from '@/types/stacks';
import DeployHistoryRow from '@/components/stacks/DeployHistoryRow';

type StatusFilter = DeployStatus | 'all';

interface DeployHistoryListProps {
  records: StackDeployRecord[];
  isLoading: boolean;
  stackName?: string;
  host?: string;
  onRollbackComplete?: () => void;
  onRollbackError?: (err: Error) => void;
}

export default function DeployHistoryList({
  records,
  isLoading,
  stackName,
  host,
  onRollbackComplete,
  onRollbackError,
}: Readonly<DeployHistoryListProps>) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [scrollMargin, setScrollMargin] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (listRef.current) {
      setScrollMargin(listRef.current.offsetTop);
    }
  }, []);

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return records;
    return records.filter((r) => r.status === statusFilter);
  }, [records, statusFilter]);

  const virtualizer = useWindowVirtualizer({
    count: filtered.length,
    estimateSize: () => 44,
    overscan: 10,
    scrollMargin,
    getItemKey: (index) => filtered[index].id,
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} variant="rounded" height={40} className="!bg-[var(--mui-palette-action-hover)]" />
        ))}
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <Typography variant="body2" className="opacity-50 py-2">
        No deploy history.
      </Typography>
    );
  }

  const hasStatusVariety = new Set(records.map((r) => r.status)).size > 1;
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div>
      {hasStatusVariety && (
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <ToggleButtonGroup
            value={statusFilter}
            exclusive
            onChange={(_e, v) => { if (v) setStatusFilter(v) }}
            size="small"
          >
            <ToggleButton value="all" className="!normal-case !px-3 !text-xs">All</ToggleButton>
            <ToggleButton value="succeeded" className="!normal-case !px-3 !text-xs">Succeeded</ToggleButton>
            <ToggleButton value="failed" className="!normal-case !px-3 !text-xs">Failed</ToggleButton>
            <ToggleButton value="pending" className="!normal-case !px-3 !text-xs">Pending</ToggleButton>
            <ToggleButton value="in_progress" className="!normal-case !px-3 !text-xs">In Progress</ToggleButton>
            <ToggleButton value="no_change" className="!normal-case !px-3 !text-xs">No Changes</ToggleButton>
          </ToggleButtonGroup>
          {filtered.length !== records.length && (
            <Typography variant="caption" className="opacity-50">
              {filtered.length} of {records.length}
            </Typography>
          )}
          <Tooltip
            title={
              <div className="p-1">
                <Typography variant="subtitle2" className="!text-inherit mb-1">Deploy History</Typography>
                <Typography variant="caption" className="!text-inherit block opacity-90">
                  Showing the most recent 100 deployments for this stack. Use the filters
                  to narrow by status. Expand a row to view its deploy logs.
                </Typography>
                <Typography variant="caption" className="!text-inherit block opacity-70 mt-1">
                  Eligible deployments can be rolled back to recreate containers from a previous compose configuration.
                </Typography>
              </div>
            }
            placement="top-start"
            slotProps={{ tooltip: { className: '!max-w-xs' } }}
          >
            <span className="p-0.5 opacity-40 hover:opacity-80 transition-opacity cursor-help">
              <HelpCircle size={14} />
            </span>
          </Tooltip>
        </div>
      )}

      {filtered.length === 0 ? (
        <Typography variant="body2" className="opacity-50 py-2">
          No deploys match the selected filters.
        </Typography>
      ) : (
        <div ref={listRef}>
          <div
            style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}
          >
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translate3d(0, ${(virtualItems[0]?.start ?? 0) - virtualizer.options.scrollMargin}px, 0)`,
              }}
            >
              {virtualItems.map((virtualRow) => {
                const record = filtered[virtualRow.index];
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    className="pb-1"
                  >
                    <DeployHistoryRow
                      record={record}
                      stackName={stackName}
                      host={host}
                      onRollbackComplete={onRollbackComplete}
                      onRollbackError={onRollbackError}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
