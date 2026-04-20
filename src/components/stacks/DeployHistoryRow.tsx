import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, Chip, Collapse, Paper } from '@mui/material';
import { ChevronRight, GitCommit } from 'lucide-react';
import type { StackDeployRecord, DeployAction, DeployStatus } from '@/types/stacks';
import { triggerDeploy } from '@/data/stacks/functions';
import RollbackDialog from '@/components/stacks/RollbackDialog';

const PENDING_APPROVAL_LABEL = 'Pending approval';

const STATUS_COLOR: Record<DeployStatus, string> = {
  succeeded: 'var(--chart-deploy-success)',
  failed: 'var(--chart-deploy-failed)',
  pending: 'var(--chart-deploy-pending)',
  in_progress: 'var(--chart-deploy-in-progress)',
  no_change: 'var(--chart-deploy-success)',
};

const STATUS_LABEL: Record<DeployStatus, string> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  pending: 'Pending',
  in_progress: 'In Progress',
  no_change: 'No Changes',
};

const ACTION_LABEL: Record<DeployAction, string> = {
  deploy: 'Deploy',
  teardown: 'Teardown',
  restart: 'Restart',
};

function getActionLabel(record: StackDeployRecord): string {
  if (record.action === 'deploy' && record.forceRecreate) return 'Force Deploy';
  return ACTION_LABEL[record.action];
}

const ROLLBACK_ELIGIBLE: Set<DeployStatus> = new Set(['succeeded', 'no_change']);

interface DeployHistoryRowProps {
  record: StackDeployRecord;
  stackName?: string;
  host?: string;
  onRollbackComplete?: () => void;
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
    onSuccess: () => onRollbackComplete?.(),
    onError: (err) => onRollbackError?.(err instanceof Error ? err : new Error(String(err))),
  });

  function handleRollbackConfirm() {
    setRollbackOpen(false);
    rollbackMutation.mutate();
  }

  return (
    <>
      <Paper
        elevation={0}
        className="!bg-[var(--mui-palette-background-chartBg)] rounded-sm overflow-hidden"
      >
        <div
          role={record.logs ? 'button' : undefined}
          tabIndex={record.logs ? 0 : undefined}
          onClick={() => record.logs && setExpanded(!expanded)}
          onKeyDown={record.logs ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!expanded); } } : undefined}
          className={`flex items-center gap-3 px-3 py-2 text-sm ${record.logs ? 'cursor-pointer hover:bg-[var(--mui-palette-action-hover)]' : ''}`}
        >
          {record.logs && (
            <ChevronRight
              size={14}
              className={`transition-transform duration-200 flex-shrink-0 ${expanded ? 'rotate-90' : ''}`}
            />
          )}
          {!record.logs && <div className="w-3.5" />}

          <GitCommit size={14} className="opacity-60 flex-shrink-0" />
          <code className="font-mono text-xs">{record.commitSha.substring(0, 7)}</code>

          <Chip
            size="small"
            label={getActionLabel(record)}
            className="!text-xs !h-5"
            variant="filled"
          />

          {isPending ? (
            <Chip
              size="small"
              color="warning"
              label={PENDING_APPROVAL_LABEL}
              className="!text-xs !h-5"
              variant="outlined"
            />
          ) : (
            <Chip
              size="small"
              label={STATUS_LABEL[record.status]}
              className="!text-xs !h-5"
              style={{ color: statusColor, borderColor: statusColor }}
              variant="outlined"
            />
          )}

          <span className="ml-auto opacity-50 text-xs whitespace-nowrap">
            {timestamp.toLocaleDateString()} {timestamp.toLocaleTimeString()}
          </span>

          {showApprovalActions && onApprove !== undefined && (
            <Button
              size="small"
              variant="contained"
              color="primary"
              className="!text-xs !h-6 !min-w-0 !px-2 !ml-1"
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
              size="small"
              variant="outlined"
              color="error"
              className="!text-xs !h-6 !min-w-0 !px-2 !ml-1"
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
              size="small"
              variant="outlined"
              className="!text-xs !h-6 !min-w-0 !px-2 !ml-1 !border-red-600 !text-red-500 hover:!bg-red-600/10"
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
          <Collapse in={expanded} unmountOnExit>
            <pre className="px-4 py-2 text-xs font-mono whitespace-pre-wrap opacity-80 border-t border-[var(--mui-palette-divider)] max-h-[200px] overflow-y-auto">
              {record.logs}
            </pre>
          </Collapse>
        )}
      </Paper>

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
