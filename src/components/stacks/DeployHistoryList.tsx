import { useMemo, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { HelpCircle } from 'lucide-react';
import type { StackDeployRecord, DeployStatus } from '@/types/stacks';
import type { triggerDeploy } from '@/data/stacks/functions';
import DeployHistoryRow from '@/components/stacks/DeployHistoryRow';

type StatusFilter = DeployStatus | 'all';
type TriggerDeployResult = Awaited<ReturnType<typeof triggerDeploy>>;

interface DeployHistoryListProps {
  records: StackDeployRecord[];
  isLoading: boolean;
  stackName?: string;
  host?: string;
  onRollbackComplete?: (result: TriggerDeployResult) => void;
  onRollbackError?: (err: Error) => void;
  onApprove?: (deployId: number) => void;
  onReject?: (deployId: number) => void;
  isApproving?: boolean;
  isRejecting?: boolean;
  _triggerDeploy?: typeof triggerDeploy;
}

export default function DeployHistoryList({
  records,
  isLoading,
  stackName,
  host,
  onRollbackComplete,
  onRollbackError,
  onApprove,
  onReject,
  isApproving,
  isRejecting,
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
          <Skeleton key={i} className="h-10 bg-accent" />
        ))}
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <p className="text-sm opacity-50 py-2">No deploy history.</p>
    );
  }

  return (
    <div>
      {hasStatusVariety && (
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <ToggleGroup
            value={[statusFilter]}
            onValueChange={(groupValue) => { const v = groupValue[0]; if (v) setStatusFilter(v as typeof statusFilter) }}
          >
            <ToggleGroupItem value="all" className="normal-case px-3">All</ToggleGroupItem>
            <ToggleGroupItem value="succeeded" className="normal-case px-3">Succeeded</ToggleGroupItem>
            <ToggleGroupItem value="failed" className="normal-case px-3">Failed</ToggleGroupItem>
            <ToggleGroupItem value="pending" className="normal-case px-3">Pending</ToggleGroupItem>
            <ToggleGroupItem value="in_progress" className="normal-case px-3">In Progress</ToggleGroupItem>
            <ToggleGroupItem value="no_change" className="normal-case px-3">No Changes</ToggleGroupItem>
            <ToggleGroupItem value="queued" className="normal-case px-3">Queued</ToggleGroupItem>
          </ToggleGroup>
          {filtered.length !== records.length && (
            <span className="text-xs opacity-50">
              {filtered.length} of {records.length}
            </span>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="p-0.5 opacity-40 hover:opacity-80 transition-opacity cursor-help" />
              }
            >
              <HelpCircle size={14} />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <div className="p-1">
                <p className="text-sm font-medium mb-1">Deploy History</p>
                <p className="text-xs block opacity-90">
                  Showing the most recent 100 deployments for this stack. Use the filters
                  to narrow by status. Expand a row to view its deploy logs.
                </p>
                <p className="text-xs block opacity-70 mt-1">
                  Eligible deployments can be rolled back to recreate containers from a previous compose configuration.
                </p>
              </div>
            </TooltipContent>
          </Tooltip>
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="text-sm opacity-50 py-2">No deploys match the selected filters.</p>
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
              onApprove={onApprove}
              onReject={onReject}
              isApproving={isApproving}
              isRejecting={isRejecting}
              _triggerDeploy={_triggerDeploy}
            />
          ))}
        </div>
      )}
    </div>
  );
}
