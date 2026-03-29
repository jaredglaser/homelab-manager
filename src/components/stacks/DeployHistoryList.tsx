import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { Button, Chip, Collapse, Paper, Skeleton, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import { ChevronRight, GitCommit, HelpCircle } from 'lucide-react';
import type { StackDeployRecord, DeployAction, DeployStatus } from '@/types/stacks';
import { triggerDeploy } from '@/data/stacks/functions';
import RollbackDialog from '@/components/stacks/RollbackDialog';

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

interface DeployHistoryRowProps {
  record: StackDeployRecord;
  stackName?: string;
  host?: string;
  onRollbackComplete?: () => void;
  onRollbackError?: (err: Error) => void;
}

function DeployHistoryRow({ record, stackName, host, onRollbackComplete, onRollbackError }: Readonly<DeployHistoryRowProps>) {
  const [expanded, setExpanded] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const statusColor = STATUS_COLOR[record.status];
  const timestamp = new Date(record.createdAt);
  const canRollback = stackName !== undefined && host !== undefined && record.action === 'deploy' && ROLLBACK_ELIGIBLE.has(record.status);

  const rollbackMutation = useMutation({
    mutationFn: () =>
      triggerDeploy({ data: { stack: stackName!, host: host!, action: 'deploy', commitSha: record.commitSha } }),
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

          <Chip
            size="small"
            label={STATUS_LABEL[record.status]}
            className="!text-xs !h-5"
            style={{ color: statusColor, borderColor: statusColor }}
            variant="outlined"
          />

          <span className="ml-auto opacity-50 text-xs whitespace-nowrap">
            {timestamp.toLocaleDateString()} {timestamp.toLocaleTimeString()}
          </span>

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
          stackName={stackName!}
          commitSha={record.commitSha}
        />
      )}
    </>
  );
}
