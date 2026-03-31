import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
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
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material'
import { Settings2 } from 'lucide-react'
import { useStacksContext } from '@/components/stacks/stacks-context'
import {
  getStackDetail,
  getDeployHistory,
  triggerDeploy,
  deleteStack,
  updateStackSettings,
  listManagedHostNames,
} from '@/data/stacks/functions'
import ComposeEditorLoader from '@/components/stacks/ComposeEditorLoader'
import VariablesPanel from '@/components/stacks/VariablesPanel'
import DeployHistoryList from '@/components/stacks/DeployHistoryList'
import ContainerList from '@/components/stacks/ContainerList'
import StackActionBar from '@/components/stacks/StackActionBar'
import DeleteStackDialog from '@/components/stacks/DeleteStackDialog'
import { STACKS_QUERY_KEY } from '@/lib/constants/stacks-keys'

/** Parse ${VAR} and ${VAR:-default} patterns from compose content */
function parseVariables(content: string): string[] {
  const regex = /\$\{([a-zA-Z_]\w*)(?::-[^}]*)?\}/g;
  const vars = new Set<string>();
  let match: RegExpMatchArray | null;
  while ((match = regex.exec(content)) !== null) {
    vars.add(match[1]);
  }
  return Array.from(vars).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export const Route = createFileRoute('/stacks/$stackName')({
  ssr: false,
  component: StackEditorView,
})

function StackEditorView() {
  const { stackName } = Route.useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { statusMap } = useStacksContext()

  const [panel, setPanel] = useState<'secrets' | 'deploys'>('secrets')
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false)
  const [forceRecreate, setForceRecreate] = useState(false)
  const [deployMessage, setDeployMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const { data: detail, isLoading, error } = useQuery({
    queryKey: ['stack-detail', stackName],
    queryFn: () => getStackDetail({ data: { stackName } }),
  })

  const { data: history, isLoading: historyLoading } = useQuery({
    queryKey: ['deploy-history', stackName],
    queryFn: () => getDeployHistory({ data: { stackName, limit: 100 } }),
  })

  const { data: availableHosts = [] } = useQuery({
    queryKey: ['managed-host-names'],
    queryFn: () => listManagedHostNames(),
    enabled: settingsDialogOpen,
  })

  const statusKey = detail ? `${detail.name}/${detail.host}` : ''
  const containers = statusMap.get(statusKey)?.containers ?? []

  const deployMutation = useMutation({
    mutationFn: (action: 'deploy' | 'restart' | 'teardown') =>
      triggerDeploy({ data: { stack: stackName, host: detail!.host, action, forceRecreate: action === 'deploy' ? forceRecreate : undefined } }),
    onSuccess: (_data, action) => {
      setDeployMessage({ type: 'success', text: `${action} triggered successfully` })
      queryClient.invalidateQueries({ queryKey: ['deploy-history', stackName] })
      queryClient.invalidateQueries({ queryKey: STACKS_QUERY_KEY })
    },
    onError: (err) => {
      setDeployMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (teardown: boolean) =>
      deleteStack({ data: { stackName, teardown } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STACKS_QUERY_KEY })
      setDeleteDialogOpen(false)
      navigate({ to: '/stacks' })
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

  const composeVars = parseVariables(detail.composeContent)

  return (
    <div className="flex flex-col h-full">
      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto themed-scrollbar">
        <div className="flex flex-col gap-4 pb-4">
          {/* Header */}
          <div className="flex items-center justify-between">
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

          {/* Compose Editor */}
          <ComposeEditorLoader
            host={detail.host}
            stackName={stackName}
            content={detail.composeContent}
            variables={composeVars}
          />

          {/* Panel Toggle */}
          <div className="flex items-center gap-3">
            <ToggleButtonGroup
              value={panel}
              exclusive
              onChange={(_e, value) => { if (value) setPanel(value) }}
              size="small"
            >
              <ToggleButton value="secrets" className="!normal-case !px-4">Secrets</ToggleButton>
              <ToggleButton value="deploys" className="!normal-case !px-4">Deploys</ToggleButton>
            </ToggleButtonGroup>
            {panel === 'deploys' && (
              <ContainerList containers={containers} />
            )}
          </div>

          {/* Panel Content */}
          {panel === 'secrets' ? (
            <VariablesPanel stackName={stackName} composeVariables={composeVars} />
          ) : (
            <DeployHistoryList
              records={history ?? []}
              isLoading={historyLoading}
              stackName={stackName}
              host={detail.host}
              onRollbackComplete={() => {
                setDeployMessage({ type: 'success', text: 'Rollback triggered successfully' })
                queryClient.invalidateQueries({ queryKey: ['deploy-history', stackName] })
                queryClient.invalidateQueries({ queryKey: STACKS_QUERY_KEY })
              }}
              onRollbackError={(err) => {
                setDeployMessage({ type: 'error', text: err.message })
              }}
            />
          )}
        </div>
      </div>

      {/* Sticky Action Bar */}
      <div className="flex-shrink-0 border-t border-[var(--mui-palette-divider)] bg-[var(--mui-palette-background-default)] px-1 py-3">
        <StackActionBar
          onDeploy={() => deployMutation.mutate('deploy')}
          onRestart={() => deployMutation.mutate('restart')}
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
  )
}

/** Settings dialog for changing host and deploy mode */
function StackSettingsDialog({
  open,
  currentHost,
  currentAutoDeploy,
  availableHosts,
  isLoading,
  onSave,
  onClose,
}: Readonly<{
  open: boolean
  currentHost: string
  currentAutoDeploy: boolean
  availableHosts: string[]
  isLoading: boolean
  onSave: (host: string, autoDeploy: boolean) => void
  onClose: () => void
}>) {
  const [host, setHost] = useState(currentHost)
  const [autoDeploy, setAutoDeploy] = useState(currentAutoDeploy)

  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setHost(currentHost)
      setAutoDeploy(currentAutoDeploy)
    }
  }

  function handleSave() {
    if (!host || isLoading) return
    onSave(host, autoDeploy)
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
  )
}
