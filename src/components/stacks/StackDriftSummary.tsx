import { Alert, Button, CircularProgress, Typography } from '@mui/material';
import { RefreshCw } from 'lucide-react';
import type { StackDriftItem, StackDriftReport, StackDriftResolution } from '@/types/stacks';
import {
  getAllowedStackDriftResolutions,
  getStackDriftKindLabel,
  getStackDriftResolutionLabel,
} from '@/lib/stacks/stack-drift-service';

interface StackDriftSummaryProps {
  report: StackDriftReport | null | undefined;
  isLoading: boolean;
  isResolving: boolean;
  onRefresh: () => void;
  onResolve: (item: StackDriftItem, resolution: StackDriftResolution) => void;
}

export default function StackDriftSummary({
  report,
  isLoading,
  isResolving,
  onRefresh,
  onResolve,
}: StackDriftSummaryProps) {
  if (!isLoading && (!report || (report.summary.total === 0 && report.scanErrors.length === 0))) {
    return null;
  }

  const disableActions = isResolving || isLoading;

  return (
    <Alert
      severity={report?.summary.total ? 'warning' : 'info'}
      className="mb-4"
      action={(
        <Button
          color="inherit"
          size="small"
          onClick={onRefresh}
          startIcon={isLoading ? <CircularProgress size={14} color="inherit" /> : <RefreshCw size={14} />}
        >
          Refresh
        </Button>
      )}
    >
      <div className="flex flex-col gap-3">
        <div>
          <Typography variant="subtitle2">Stack Drift</Typography>
          {report ? (
            <Typography variant="body2">
              {report.summary.ghost} ghost, {report.summary.untracked} untracked, {report.summary.content} content
            </Typography>
          ) : (
            <Typography variant="body2">Checking agent stack state...</Typography>
          )}
        </div>

        {report?.scanErrors.map((error) => (
          <Typography key={error.host} variant="body2">
            {error.host}: {error.message}
          </Typography>
        ))}

        {report?.items.map((item) => (
          <div key={`${item.host}/${item.stack}`} className="flex flex-wrap items-center gap-2">
            <Typography variant="body2" className="font-medium">
              {item.host}/{item.stack}
            </Typography>
            <Typography variant="caption" className="opacity-70">
              {getStackDriftKindLabel(item.kind)}
            </Typography>
            {getAllowedStackDriftResolutions(item.kind).map((resolution) => (
              <Button
                key={resolution}
                size="small"
                variant="outlined"
                disabled={disableActions}
                onClick={() => onResolve(item, resolution)}
              >
                {getStackDriftResolutionLabel(resolution)}
              </Button>
            ))}
          </div>
        ))}
      </div>
    </Alert>
  );
}
