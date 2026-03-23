import { useQuery } from '@tanstack/react-query';
import { CircularProgress, Typography } from '@mui/material';
import { getStackDetail, getDeployHistory } from '@/data/stacks/functions';
import ComposeEditorLoader from '@/components/stacks/ComposeEditorLoader';
import DeployHistoryList from '@/components/stacks/DeployHistoryList';

interface StackDetailProps {
  host: string;
  stackName: string;
}

export default function StackDetail({ host, stackName }: StackDetailProps) {
  const { data: detail, isLoading, error } = useQuery({
    queryKey: ['stack-detail', host, stackName],
    queryFn: () => getStackDetail({ data: { stackName } }),
  });

  const { data: history, isLoading: historyLoading } = useQuery({
    queryKey: ['deploy-history', host, stackName],
    queryFn: () => getDeployHistory({ data: { stackName, limit: 10 } }),
  });

  if (isLoading) {
    return (
      <div className="p-4 border-t border-[var(--mui-palette-divider)] bg-[var(--mui-palette-background-level1)]">
        <div className="flex items-center gap-2 text-sm opacity-70">
          <CircularProgress size={16} />
          <span>Loading details for {stackName}...</span>
        </div>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="p-4 border-t border-[var(--mui-palette-divider)] bg-[var(--mui-palette-background-level1)]">
        <Typography variant="body2" className="opacity-70">
          {error ? `Failed to load: ${error.message}` : 'Stack not found in repository.'}
        </Typography>
      </div>
    );
  }

  return (
    <div className="p-4 border-t border-[var(--mui-palette-divider)] bg-[var(--mui-palette-background-level1)]">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <div>
          <ComposeEditorLoader
            host={host}
            stackName={stackName}
            content={detail.composeContent}
            variables={detail.variableNames}
          />
        </div>
        <div>
          <DeployHistoryList
            records={history ?? []}
            isLoading={historyLoading}
          />
        </div>
      </div>
    </div>
  );
}
