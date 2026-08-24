import { RefreshCw } from 'lucide-react';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import StackDriftActions from '@/components/stacks/StackDriftActions';
import type { StackDriftReport } from '@/types/stacks';
import { getStackDriftKindLabel } from '@/lib/stacks/stack-drift-service';

interface StackDriftSummaryProps {
  report: StackDriftReport | null | undefined;
  isLoading: boolean;
  onRefresh: () => void;
}

export default function StackDriftSummary({ report, isLoading, onRefresh }: StackDriftSummaryProps) {
  if (!isLoading && (!report || (report.summary.total === 0 && report.scanErrors.length === 0))) {
    return null;
  }

  return (
    <Alert variant={report?.summary.total ? 'warning' : 'info'} className="mb-4 block">
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <AlertTitle>Stack Drift</AlertTitle>
            <AlertDescription>
              {report ? (
                <span>
                  {report.summary.ghost} ghost, {report.summary.untracked} untracked, {report.summary.content} content
                </span>
              ) : (
                <span>Checking agent stack state...</span>
              )}
            </AlertDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            {isLoading ? <Spinner className="size-3.5" /> : <RefreshCw size={14} />}
            Refresh
          </Button>
        </div>

        {report?.scanErrors.map((error) => (
          <p key={`${error.host}/${error.stack ?? ''}`} className="text-sm">
            {error.stack ? `${error.host}/${error.stack}` : error.host}: {error.message}
          </p>
        ))}

        {report?.items.map((item) => (
          <div key={`${item.host}/${item.stack}`} className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">
              {item.host}/{item.stack}
            </span>
            <span className="text-xs opacity-70">{getStackDriftKindLabel(item.kind)}</span>
            <StackDriftActions item={item} />
          </div>
        ))}
      </div>
    </Alert>
  );
}
