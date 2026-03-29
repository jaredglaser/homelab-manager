import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormLabel,
  IconButton,
  MenuItem,
  Select,
  Snackbar,
  Switch,
  Tooltip,
  Typography,
} from '@mui/material';
import { Settings2 } from 'lucide-react';
import { getStackDetail, getDeployHistory, triggerDeploy, deleteStack, updateStackSettings, listManagedHostNames } from '@/data/stacks/functions';
import ComposeEditorLoader from '@/components/stacks/ComposeEditorLoader';
import DeployHistoryList from '@/components/stacks/DeployHistoryList';
import ContainerList from '@/components/stacks/ContainerList';
import StackActionBar from '@/components/stacks/StackActionBar';
import DeleteStackDialog from '@/components/stacks/DeleteStackDialog';
import type { StackContainer } from '@/types/stacks';
import { STACKS_QUERY_KEY } from '@/lib/constants/stacks-keys';

// ----- Stack settings dialog -----

interface StackSettingsDialogProps {
  open: boolean;
  currentHost: string;
  currentAutoDeploy: boolean;
  availableHosts: string[];
  isLoading: boolean;
  onSave: (host: string, autoDeploy: boolean) => void;
  onClose: () => void;
}

function StackSettingsDialog({
  open,
  currentHost,
  currentAutoDeploy,
  availableHosts,
  isLoading,
  onSave,
  onClose,
}: Readonly<StackSettingsDialogProps>) {
  const [host, setHost] = useState(currentHost);
  const [autoDeploy, setAutoDeploy] = useState(currentAutoDeploy);

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setHost(currentHost);
      setAutoDeploy(currentAutoDeploy);
    }
  }

  function handleSave() {
    if (!host || isLoading) return;
    onSave(host, autoDeploy);
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Stack Settings</DialogTitle>
      <DialogContent className="flex flex-col gap-4 !pt-4">
        <FormControl fullWidth disabled={isLoading}>
          <FormLabel className="!text-sm !mb-1">Target Host</FormLabel>
          <Select
            value={host}
            onChange={(e) => setHost(e.target.value)}
            displayEmpty
            inputProps={{ 'aria-label': 'Target Host' }}
          >
            {availableHosts.map((h) => (
              <MenuItem key={h} value={h}>{h}</MenuItem>
            ))}
          </Select>
        </FormControl>
        <div className="flex items-center gap-3">
          <Switch
            checked={autoDeploy}
            onChange={(e) => setAutoDeploy(e.target.checked)}
            disabled={isLoading}
            inputProps={{ 'aria-label': 'Auto Deploy' }}
          />
          <div>
            <Typography variant="body2" className="font-medium">Auto Deploy</Typography>
            <Typography variant="caption" className="opacity-70">
              {autoDeploy ? 'Deploy on every git push' : 'Deploy only when triggered manually'}
            </Typography>
          </div>
        </div>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit" disabled={isLoading}>Cancel</Button>
        <Button onClick={handleSave} variant="contained" disabled={!host || isLoading}>
          {isLoading ? <CircularProgress size={16} /> : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ----- Main component -----

interface StackDetailProps {
  host: string;
  stackName: string;
  containers: StackContainer[];
  onDeleted?: () => void;
}

export default function StackDetail({ stackName, host, containers, onDeleted }: Readonly<StackDetailProps>) {
  const queryClient = useQueryClient();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);

  const { data: detail, isLoading, error } = useQuery({
    queryKey: ['stack-detail', host, stackName],
    queryFn: () => getStackDetail({ data: { stackName } }),
  });

  const { data: history, isLoading: historyLoading } = useQuery({
    queryKey: ['deploy-history', host, stackName],
    queryFn: () => getDeployHistory({ data: { stackName, limit: 10 } }),
  });

  const { data: availableHosts = [] } = useQuery({
    queryKey: ['managed-host-names'],
    queryFn: () => listManagedHostNames(),
    enabled: settingsDialogOpen,
  });

  const [deployMessage, setDeployMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [forceRecreate, setForceRecreate] = useState(false);

  const deployMutation = useMutation({
    mutationFn: (action: 'deploy' | 'restart' | 'teardown') =>
      triggerDeploy({ data: { stack: stackName, host, action, forceRecreate: action === 'deploy' ? forceRecreate : undefined } }),
    onSuccess: (_data, action) => {
      setDeployMessage({ type: 'success', text: `${action} triggered successfully` });
      queryClient.invalidateQueries({ queryKey: ['deploy-history', stackName] });
      queryClient.invalidateQueries({ queryKey: ['stacks-list'] });
    },
    onError: (err) => {
      setDeployMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (teardown: boolean) =>
      deleteStack({ data: { stackName, teardown } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STACKS_QUERY_KEY });
      setDeleteDialogOpen(false);
      onDeleted?.();
    },
  });

  const settingsMutation = useMutation({
    mutationFn: ({ newHost, autoDeploy }: { newHost: string; autoDeploy: boolean }) =>
      updateStackSettings({ data: { stackName, host: newHost, autoDeploy } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stack-detail', stackName] });
      queryClient.invalidateQueries({ queryKey: ['stacks-list'] });
      setSettingsDialogOpen(false);
      setDeployMessage({ type: 'success', text: 'Stack settings updated' });
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
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Typography variant="caption" className="text-[var(--mui-palette-text-secondary)]">
            {detail.host}
          </Typography>
          <Typography variant="caption" className="text-[var(--mui-palette-text-secondary)]">
            &middot;
          </Typography>
          <Typography variant="caption" className="text-[var(--mui-palette-text-secondary)]">
            {detail.deployMode === 'auto' ? 'Auto Deploy' : 'Manual Deploy'}
          </Typography>
        </div>
        <Tooltip title="Stack settings">
          <IconButton
            size="small"
            onClick={() => setSettingsDialogOpen(true)}
            aria-label="stack settings"
          >
            <Settings2 size={16} />
          </IconButton>
        </Tooltip>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <div>
          <ComposeEditorLoader
            host={host}
            stackName={stackName}
            content={detail.composeContent}
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
              onRollbackComplete={() => {
                setDeployMessage({ type: 'success', text: 'Rollback triggered successfully' });
                queryClient.invalidateQueries({ queryKey: ['deploy-history', stackName] });
                queryClient.invalidateQueries({ queryKey: STACKS_QUERY_KEY });
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
        onDelete={() => setDeleteDialogOpen(true)}
        isDeploying={deployMutation.isPending}
        forceRecreate={forceRecreate}
        onForceRecreateChange={setForceRecreate}
      />
      <StackSettingsDialog
        open={settingsDialogOpen}
        currentHost={detail.host}
        currentAutoDeploy={detail.deployMode === 'auto'}
        availableHosts={availableHosts.length > 0 ? availableHosts : [detail.host]}
        isLoading={settingsMutation.isPending}
        onSave={(newHost, autoDeploy) => settingsMutation.mutate({ newHost, autoDeploy })}
        onClose={() => setSettingsDialogOpen(false)}
      />
      <DeleteStackDialog
        open={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        onConfirm={(teardown) => deleteMutation.mutate(teardown)}
        stackName={stackName}
        isLoading={deleteMutation.isPending}
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
