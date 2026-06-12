import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { ChevronRight, GitCommit } from 'lucide-react';
import type { StackDeployRecord, DeployAction, DeployStatus } from '@/types/stacks';
import { triggerDeploy } from '@/data/stacks/functions';
import RollbackDialog from '@/components/stacks/RollbackDialog';

type TriggerDeployResult = Awaited<ReturnType<typeof triggerDeploy>>;

const PENDING_APPROVAL_LABEL = 'Pending approval';

const STATUS_COLOR: Record<DeployStatus, string> = {
  succeeded: 'var(--chart-deploy-success)',
  failed: 'var(--chart-deploy-failed)',
  pending: 'var(--chart-deploy-pending)',
  in_progress: 'var(--chart-deploy-in-progress)',
  no_change: 'var(--chart-deploy-success)',
  queued: 'var(--chart-deploy-pending)',
};

const STATUS_LABEL: Record<DeployStatus, string> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  pending: 'Pending',
  in_progress: 'In Progress',
  no_change: 'No Changes',
  queued: 'Queued',
};

const ACTION_LABEL: Record<DeployAction, string> = {
  deploy: 'Deploy',
  teardown: 'Teardown',
  update: 'Image update',
};

function getActionLabel(record: StackDeployRecord): string {
  if (record.action === 'deploy' && record.trigger === 'manual_rollback') return 'Rollback';
  if (record.action === 'deploy' && record.forceRecreate) return 'Recreate';
  return ACTION_LABEL[record.action];
}

const ROLLBACK_ELIGIBLE: Set<DeployStatus> = new Set(['succeeded', 'no_change']);

interface DeployHistoryRowProps {
  record: StackDeployRecord;
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

export default function DeployHistoryRow({ record, stackName, host, onRollbackComplete, onRollbackError, onApprove, onReject, isApproving, isRejecting, _triggerDeploy }: Readonly<DeployHistoryRowProps>) {
  const [expanded, setExpanded] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const statusColor = STATUS_COLOR[record.status];
  const timestamp = new Date(record.createdAt);
  const canRollback = stackName !== undefined && host !== undefined && record.action === 'deploy' && ROLLBACK_ELIGIBLE.has(record.status);
  const isPending = record.status === 'pending';
  const showApprovalActions = isPending && (onApprove !== undefined || onReject !== undefined);

  const rollbackMutation = useMutation({
    mutationFn: () =>
      (_triggerDeploy ?? triggerDeploy)({ data: { stack: stackName!, host: host!, action: 'deploy', commitSha: record.commitSha } }),
    onSuccess: (data) => onRollbackComplete?.(data),
    onError: (err) => onRollbackError?.(err instanceof Error ? err : new Error(String(err))),
  });

  function handleRollbackConfirm() {
    setRollbackOpen(false);
    rollbackMutation.mutate();
  }

  return (
    <>
      <div className="bg-chart-bg rounded-sm overflow-hidden">
        <div
          role={record.logs ? 'button' : undefined}
          tabIndex={record.logs ? 0 : undefined}
          onClick={() => record.logs && setExpanded(!expanded)}
          onKeyDown={record.logs ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!expanded); } } : undefined}
          className={`flex items-center gap-3 px-3 py-2 text-sm ${record.logs ? 'cursor-pointer hover:bg-accent' : ''}`}
        >
          {record.logs && (
            <ChevronRight
              size={14}
              className={`transition-transform duration-200 shrink-0 ${expanded ? 'rotate-90' : ''}`}
            />
          )}
          {!record.logs && <div className="w-3.5" />}

          <GitCommit size={14} className="opacity-60 shrink-0" />
          <code className="font-mono text-xs">{record.commitSha.substring(0, 7)}</code>

          <Badge variant="secondary" className="h-5">{getActionLabel(record)}</Badge>

          {isPending ? (
            <Badge variant="outline" className="h-5 border-warning text-warning">
              {PENDING_APPROVAL_LABEL}
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="h-5"
              style={{ color: statusColor, borderColor: statusColor }}
            >
              {STATUS_LABEL[record.status]}
            </Badge>
          )}

          <span className="ml-auto opacity-50 text-xs whitespace-nowrap">
            {timestamp.toLocaleDateString()} {timestamp.toLocaleTimeString()}
          </span>

          {showApprovalActions && onApprove !== undefined && (
            <Button
              size="sm"
              className="text-xs h-6 px-2 ml-1"
              onClick={(e) => {
                e.stopPropagation();
                onApprove(record.id);
              }}
              onKeyDown={(e) => e.stopPropagation()}
              disabled={isApproving || isRejecting}
            >
              Approve
            </Button>
          )}
          {showApprovalActions && onReject !== undefined && (
            <Button
              size="sm"
              variant="outline"
              className="text-xs h-6 px-2 ml-1 text-destructive border-destructive/50 hover:border-destructive hover:bg-destructive/5"
              onClick={(e) => {
                e.stopPropagation();
                onReject(record.id);
              }}
              onKeyDown={(e) => e.stopPropagation()}
              disabled={isApproving || isRejecting}
            >
              Reject
            </Button>
          )}

          {canRollback && (
            <Button
              size="sm"
              variant="outline"
              className="text-xs h-6 px-2 ml-1 border-destructive text-destructive hover:bg-destructive/10"
              onClick={(e) => {
                e.stopPropagation();
                setRollbackOpen(true);
              }}
              disabled={rollbackMutation.isPending}
            >
              Rollback
            </Button>
          )}
        </div>

        {record.logs && (
          <Collapsible open={expanded}>
            <CollapsibleContent>
              <pre className="px-4 py-2 text-xs font-mono whitespace-pre-wrap opacity-80 border-t border-border max-h-[200px] overflow-y-auto">
                {record.logs}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>

      {canRollback && (
        <RollbackDialog
          open={rollbackOpen}
          onClose={() => setRollbackOpen(false)}
          onConfirm={handleRollbackConfirm}
          stackName={stackName}
          commitSha={record.commitSha}
        />
      )}
    </>
  );
}
