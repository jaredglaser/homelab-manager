import { useMemo, useState } from 'react';
import { Skeleton, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import { HelpCircle } from 'lucide-react';
import type { StackDeployRecord, DeployStatus } from '@/types/stacks';
import type { triggerDeploy } from '@/data/stacks/functions';
import DeployHistoryRow from '@/components/stacks/DeployHistoryRow';

type StatusFilter = DeployStatus | 'all';

interface DeployHistoryListProps {
  records: StackDeployRecord[];
  isLoading: boolean;
  stackName?: string;
  host?: string;
  onRollbackComplete?: () => void;
  onRollbackError?: (err: Error) => void;
  _triggerDeploy?: typeof triggerDeploy;
}

export default function DeployHistoryList({
  records,
  isLoading,
  stackName,
  host,
  onRollbackComplete,
  onRollbackError,
  _triggerDeploy,
}: Readonly<DeployHistoryListProps>) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return records;
    return records.filter((r) => r.status === statusFilter);
  }, [records, statusFilter]);

  const hasStatusVariety = useMemo(() => new Set(records.map((r) => r.status)).size > 1, [records]);

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
        <div className="flex flex-col gap-1">
          {filtered.map((record) => (
            <DeployHistoryRow
              key={record.id}
              record={record}
              stackName={stackName}
              host={host}
              onRollbackComplete={onRollbackComplete}
              onRollbackError={onRollbackError}
              _triggerDeploy={_triggerDeploy}
            />
          ))}
        </div>
      )}
    </div>
  );
}
