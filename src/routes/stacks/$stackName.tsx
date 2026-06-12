import { useState, useEffect, useMemo } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Alert,
  CircularProgress,
  IconButton,
  Snackbar,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material'
import { Settings2 } from 'lucide-react'
import { useStackStatusContext } from '@/components/stacks/stacks-context'
import { useToast } from '@/hooks/toastAtom'
import {
  getStackDetail,
  getDeployHistory,
  triggerDeploy,
  deleteStack,
  updateStackSettings,
  listManagedHostNames,
  resumeDeploy,
  rejectDeploy,
} from '@/data/stacks/functions'
import ComposeEditorLoader from '@/components/stacks/ComposeEditorLoader'
import VariablesPanel from '@/components/stacks/VariablesPanel'
import DeployHistoryList from '@/components/stacks/DeployHistoryList'
import StackContainersPanel from '@/components/stacks/StackContainersPanel'
import StackActionBar from '@/components/stacks/StackActionBar'
import DeleteStackDialog from '@/components/stacks/DeleteStackDialog'
import StackSettingsDialog from '@/components/stacks/StackSettingsDialog'
import { STACKS_QUERY_KEY, DEPLOY_HISTORY_QUERY_KEY } from '@/lib/constants/stacks-keys'
import { parseVariables } from '@/lib/stacks/parse-variables'

export const Route = createFileRoute('/stacks/$stackName')({
  ssr: false,
  component: StackEditorView,
})

function StackEditorView() {
  const { stackName } = Route.useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { statusMap, deployVersion } = useStackStatusContext()
  const { showToast } = useToast()

  const [panel, setPanel] = useState<'compose' | 'secrets' | 'containers' | 'deploys'>('compose')
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false)
  const [forceRecreate, setForceRecreate] = useState(false)
  const [deployMessage, setDeployMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const { data: detail, isLoading, error } = useQuery({
    queryKey: ['stack-detail', stackName],
    queryFn: () => getStackDetail({ data: { stackName } }),
  })

  const { data: history, isLoading: historyLoading } = useQuery({
    queryKey: [...DEPLOY_HISTORY_QUERY_KEY, stackName],
    queryFn: () => getDeployHistory({ data: { stackName, limit: 100 } }),
  })

  const { data: availableHosts = [] } = useQuery({
    queryKey: ['managed-host-names'],
    queryFn: () => listManagedHostNames(),
    enabled: settingsDialogOpen,
  })

  // Invalidate deploy history when a deploy completes
  useEffect(() => {
    if (deployVersion === 0) return;
    queryClient.invalidateQueries({ queryKey: [...DEPLOY_HISTORY_QUERY_KEY, stackName] });
  }, [deployVersion, stackName, queryClient]);

  const composeVars = useMemo(() => parseVariables(detail?.composeContent ?? ''), [detail?.composeContent])

  const statusKey = detail ? `${detail.host}/${detail.name}` : ''
  const containers = statusMap.get(statusKey)?.containers ?? []

  const deployMutation = useMutation({
    mutationFn: (action: 'deploy' | 'teardown') =>
      triggerDeploy({ data: { stack: stackName, host: detail!.host, action, forceRecreate: action === 'deploy' ? forceRecreate : undefined } }),
    onSuccess: (_data, action) => {
      setDeployMessage({ type: 'success', text: `${action} triggered successfully` })
      queryClient.invalidateQueries({ queryKey: [...DEPLOY_HISTORY_QUERY_KEY, stackName] })
      queryClient.invalidateQueries({ queryKey: STACKS_QUERY_KEY })
    },
    onError: (err) => {
      setDeployMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (teardown: boolean) =>
      deleteStack({ data: { stackName, teardown } }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: STACKS_QUERY_KEY })
      if (result.status === 'teardown-pending') {
        showToast(`Teardown queued for ${stackName}: the stack will be removed when the agent finishes.`, 'success')
      }
    },
    onError: (err) => {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    },
  })

  function handleDeleteConfirm(teardown: boolean) {
    // Fire the mutation without awaiting; for teardown the server returns
    // immediately with a deployId and the pipeline handles the manifest delete
    // asynchronously. Close the dialog and navigate right away so the user
    // isn't held up waiting for the agent.
    deleteMutation.mutate(teardown)
    setDeleteDialogOpen(false)
    navigate({ to: '/stacks' })
  }

  const approveMutation = useMutation({
    mutationFn: (deployId: number) => resumeDeploy({ data: { deployId } }),
    onSuccess: () => {
      setDeployMessage({ type: 'success', text: `Deploy approved for ${stackName}` })
      queryClient.invalidateQueries({ queryKey: [...DEPLOY_HISTORY_QUERY_KEY, stackName] })
      queryClient.invalidateQueries({ queryKey: STACKS_QUERY_KEY })
    },
    onError: (err) => {
      setDeployMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) })
      queryClient.invalidateQueries({ queryKey: [...DEPLOY_HISTORY_QUERY_KEY, stackName] })
    },
  })

  const rejectMutation = useMutation({
    mutationFn: (deployId: number) => rejectDeploy({ data: { deployId } }),
    onSuccess: () => {
      setDeployMessage({ type: 'success', text: `Deploy rejected for ${stackName}` })
      queryClient.invalidateQueries({ queryKey: [...DEPLOY_HISTORY_QUERY_KEY, stackName] })
      queryClient.invalidateQueries({ queryKey: STACKS_QUERY_KEY })
    },
    onError: (err) => {
      setDeployMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) })
      queryClient.invalidateQueries({ queryKey: [...DEPLOY_HISTORY_QUERY_KEY, stackName] })
    },
  })

  const settingsMutation = useMutation({
    mutationFn: ({ newHost, autoDeploy }: { newHost: string; autoDeploy: boolean }) =>
      updateStackSettings({ data: { stackName, host: newHost, autoDeploy } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stack-detail', stackName] })
      queryClient.invalidateQueries({ queryKey: STACKS_QUERY_KEY })
      setSettingsDialogOpen(false)
      setDeployMessage({ type: 'success', text: 'Stack settings updated' })
    },
    onError: (err) => {
      setDeployMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) })
    },
  })

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm opacity-70 py-8">
        <CircularProgress size={16} />
        <span>Loading {stackName}...</span>
      </div>
    )
  }

  if (error || !detail) {
    return (
      <Typography variant="body2" className="opacity-70 py-8">
        {error ? `Failed to load: ${error.message}` : 'Stack not found in repository.'}
      </Typography>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between pb-3">
        <div className="flex items-center gap-3">
          <Typography variant="h6">{stackName}</Typography>
          <Typography variant="caption" className="opacity-50">
            {detail.host}
          </Typography>
          <Typography variant="caption" className="opacity-50">
            &middot;
          </Typography>
          <Typography variant="caption" className="opacity-50">
            {detail.deployMode === 'auto' ? 'Auto Deploy' : 'Manual Deploy'}
          </Typography>
        </div>
        <Tooltip title="Stack settings">
          <IconButton size="small" onClick={() => setSettingsDialogOpen(true)} aria-label="stack settings">
            <Settings2 size={16} />
          </IconButton>
        </Tooltip>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-3 border-b border-(--mui-palette-divider)">
        <Tabs
          value={panel}
          onChange={(_e, value: 'compose' | 'secrets' | 'containers' | 'deploys') => setPanel(value)}
          className="min-h-0"
        >
          <Tab value="compose" label="Compose" disableRipple className="min-h-0 py-2 normal-case" />
          <Tab value="secrets" label="Secrets" disableRipple className="min-h-0 py-2 normal-case" />
          <Tab value="containers" label="Containers" disableRipple className="min-h-0 py-2 normal-case" />
          <Tab value="deploys" label="Deploys" disableRipple className="min-h-0 py-2 normal-case" />
        </Tabs>
      </div>

      {/* Tab content, scrollable */}
      <div className="flex-1 overflow-y-auto themed-scrollbar">
        <div className="flex flex-col gap-4 py-4">
          {panel === 'compose' && (
            <ComposeEditorLoader
              stackName={stackName}
              content={detail.composeContent}
            />
          )}
          {panel === 'secrets' && (
            <VariablesPanel stackName={stackName} composeVariables={composeVars} />
          )}
          {panel === 'containers' && (
            <StackContainersPanel
              containers={containers}
              stackName={stackName}
              host={detail.host}
            />
          )}
          {panel === 'deploys' && (
            <DeployHistoryList
              records={history ?? []}
              isLoading={historyLoading}
              stackName={stackName}
              host={detail.host}
              onRollbackComplete={() => {
                setDeployMessage({ type: 'success', text: 'Rollback triggered successfully' })
                queryClient.invalidateQueries({ queryKey: [...DEPLOY_HISTORY_QUERY_KEY, stackName] })
                queryClient.invalidateQueries({ queryKey: STACKS_QUERY_KEY })
              }}
              onRollbackError={(err) => {
                setDeployMessage({ type: 'error', text: err.message })
              }}
              onApprove={(deployId) => approveMutation.mutate(deployId)}
              onReject={(deployId) => rejectMutation.mutate(deployId)}
              isApproving={approveMutation.isPending}
              isRejecting={rejectMutation.isPending}
            />
          )}
        </div>
      </div>

      {/* Sticky Action Bar */}
      <div className="shrink-0 border-t border-(--mui-palette-divider) bg-(--mui-palette-background-default) px-1 py-3">
        <StackActionBar
          onDeploy={() => deployMutation.mutate('deploy')}
          onTeardown={() => deployMutation.mutate('teardown')}
          onDelete={() => setDeleteDialogOpen(true)}
          isDeploying={deployMutation.isPending}
          forceRecreate={forceRecreate}
          onForceRecreateChange={setForceRecreate}
        />
      </div>

      {/* Dialogs */}
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
        onConfirm={handleDeleteConfirm}
        stackName={stackName}
        isLoading={deleteMutation.isPending}
      />
      {deployMessage && (
        <Snackbar
          open
          autoHideDuration={5000}
          onClose={() => setDeployMessage(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert
            severity={deployMessage.type}
            onClose={() => setDeployMessage(null)}
            variant="filled"
            className="text-sm"
          >
            {deployMessage.text}
          </Alert>
        </Snackbar>
      )}
    </div>
  )
}
