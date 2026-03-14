import { useState } from 'react';
import { Chip, Collapse, Paper, Skeleton, Typography } from '@mui/material';
import { ChevronRight, GitCommit } from 'lucide-react';
import type { DeployRecord, DeployStatus, DeployTrigger } from '@/types/stacks';

const STATUS_COLOR: Record<DeployStatus, string> = {
  succeeded: 'var(--chart-deploy-success)',
  failed: 'var(--chart-deploy-failed)',
  pending: 'var(--chart-deploy-pending)',
  in_progress: 'var(--chart-deploy-in-progress)',
  no_change: 'var(--chart-text-muted)',
};

const STATUS_LABEL: Record<DeployStatus, string> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  pending: 'Pending',
  in_progress: 'In Progress',
  no_change: 'No Change',
};

const TRIGGER_LABEL: Record<DeployTrigger, string> = {
  git_push: 'Git Push',
  ui: 'UI',
  manual_rollback: 'Rollback',
};

interface DeployHistoryListProps {
  records: DeployRecord[];
  isLoading: boolean;
}

export default function DeployHistoryList({ records, isLoading }: DeployHistoryListProps) {
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
    <div className="space-y-1">
      {records.map((record) => (
        <DeployHistoryRow key={record.id} record={record} />
      ))}
    </div>
  );
}

function DeployHistoryRow({ record }: { record: DeployRecord }) {
  const [expanded, setExpanded] = useState(false);
  const statusColor = STATUS_COLOR[record.status];
  const timestamp = new Date(record.createdAt);

  return (
    <Paper
      elevation={0}
      className="!bg-[var(--mui-palette-background-chartBg)] rounded-sm overflow-hidden"
    >
      <div
        onClick={() => record.logs && setExpanded(!expanded)}
        className={`flex items-center gap-3 px-3 py-2 text-sm ${record.logs ? 'cursor-pointer hover:bg-blue-500/5' : ''}`}
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
          label={STATUS_LABEL[record.status]}
          className="!text-xs !h-5"
          style={{ color: statusColor, borderColor: statusColor }}
          variant="outlined"
        />

        <Chip
          size="small"
          label={TRIGGER_LABEL[record.trigger]}
          className="!text-xs !h-5"
          variant="filled"
        />

        <span className="ml-auto opacity-50 text-xs whitespace-nowrap">
          {timestamp.toLocaleDateString()} {timestamp.toLocaleTimeString()}
        </span>
      </div>

      {record.logs && (
        <Collapse in={expanded} unmountOnExit>
          <pre className="px-4 py-2 text-xs font-mono whitespace-pre-wrap opacity-80 border-t border-neutral-200 dark:border-neutral-700 max-h-[200px] overflow-y-auto">
            {record.logs}
          </pre>
        </Collapse>
      )}
    </Paper>
  );
}
