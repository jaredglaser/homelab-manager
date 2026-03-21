import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, CircularProgress, Snackbar, Typography } from '@mui/material';
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
  const queryClient = useQueryClient();

  const { data: detail, isLoading, error } = useQuery({
    queryKey: ['stack-detail', stackName],
    queryFn: () => getStackDetail({ data: { stackName } }),
  });

  const { data: history, isLoading: historyLoading } = useQuery({
    queryKey: ['deploy-history', stackName],
    queryFn: () => getDeployHistory({ data: { stackName, limit: 10 } }),
  });

  const [deployMessage, setDeployMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const deployMutation = useMutation({
    mutationFn: (action: 'deploy' | 'restart' | 'teardown') =>
      triggerDeploy({ data: { stack: stackName, host, action } }),
    onSuccess: (_data, action) => {
      setDeployMessage({ type: 'success', text: `${action} triggered successfully` });
      void queryClient.invalidateQueries({ queryKey: ['deploy-history', stackName] });
      void queryClient.invalidateQueries({ queryKey: ['stacks-list'] });
    },
    onError: (err) => {
      setDeployMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    },
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
              stackName={stackName}
              host={host}
              onRollbackSuccess={() => {
                setDeployMessage({ type: 'success', text: 'Rollback triggered successfully' });
                void queryClient.invalidateQueries({ queryKey: ['deploy-history', stackName] });
                void queryClient.invalidateQueries({ queryKey: ['stacks-list'] });
              }}
              onRollbackError={(err) => {
                setDeployMessage({ type: 'error', text: err.message });
              }}
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
      <Snackbar
        open={deployMessage !== null}
        autoHideDuration={5000}
        onClose={() => setDeployMessage(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {deployMessage ? (
          <Alert
            severity={deployMessage.type}
            onClose={() => setDeployMessage(null)}
            variant="filled"
            className="!text-sm"
          >
            {deployMessage.text}
          </Alert>
        ) : undefined}
      </Snackbar>
    </div>
  );
}
