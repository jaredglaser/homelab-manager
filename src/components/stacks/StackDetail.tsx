import { useQuery, useMutation } from '@tanstack/react-query';
import { CircularProgress, Typography } from '@mui/material';
import { getStackDetail, getDeployHistory, triggerDeploy } from '@/data/stacks.functions';
import ComposeEditorLoader from '@/components/stacks/ComposeEditorLoader';
import DeployHistoryList from '@/components/stacks/DeployHistoryList';
import ContainerList from '@/components/stacks/ContainerList';
import StackActionBar from '@/components/stacks/StackActionBar';
import type { StackContainer } from '@/types/stacks';

interface StackDetailProps {
  stackName: string;
  host: string;
  containers: StackContainer[];
}

export default function StackDetail({ stackName, host, containers }: Readonly<StackDetailProps>) {
  const { data: detail, isLoading, error } = useQuery({
    queryKey: ['stack-detail', stackName],
    queryFn: () => getStackDetail({ data: { stackName } }),
  });

  const { data: history, isLoading: historyLoading } = useQuery({
    queryKey: ['deploy-history', stackName],
    queryFn: () => getDeployHistory({ data: { stackName, limit: 10 } }),
  });

  const deployMutation = useMutation({
    mutationFn: (action: 'deploy' | 'restart' | 'teardown') =>
      triggerDeploy({ data: { stack: stackName, host, action } }),
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
            stackName={stackName}
            content={detail.composeContent}
            variables={detail.variableNames}
          />
        </div>
        <div>
          <ContainerList containers={containers} />
          <div className="mt-4">
            <DeployHistoryList
              records={history ?? []}
              isLoading={historyLoading}
            />
          </div>
        </div>
      </div>
      <StackActionBar
        onDeploy={() => deployMutation.mutate('deploy')}
        onRestart={() => deployMutation.mutate('restart')}
        onTeardown={() => deployMutation.mutate('teardown')}
        onDelete={() => { /* wired to DeleteStackDialog in Task 13 */ }}
        isDeploying={deployMutation.isPending}
      />
    </div>
  );
}
