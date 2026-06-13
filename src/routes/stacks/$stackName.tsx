import { useState, useEffect, useMemo } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
import { Spinner } from '@/components/ui/spinner';

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
      showToast(`${action} triggered successfully`, 'success')
      queryClient.invalidateQueries({ queryKey: [...DEPLOY_HISTORY_QUERY_KEY, stackName] })
      queryClient.invalidateQueries({ queryKey: STACKS_QUERY_KEY })
    },
    onError: (err) => {
      showToast(err instanceof Error ? err.message : String(err), 'error')
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
      showToast(`Deploy approved for ${stackName}`, 'success')
      queryClient.invalidateQueries({ queryKey: [...DEPLOY_HISTORY_QUERY_KEY, stackName] })
      queryClient.invalidateQueries({ queryKey: STACKS_QUERY_KEY })
    },
    onError: (err) => {
      showToast(err instanceof Error ? err.message : String(err), 'error')
      queryClient.invalidateQueries({ queryKey: [...DEPLOY_HISTORY_QUERY_KEY, stackName] })
    },
  })

  const rejectMutation = useMutation({
    mutationFn: (deployId: number) => rejectDeploy({ data: { deployId } }),
    onSuccess: () => {
      showToast(`Deploy rejected for ${stackName}`, 'success')
      queryClient.invalidateQueries({ queryKey: [...DEPLOY_HISTORY_QUERY_KEY, stackName] })
      queryClient.invalidateQueries({ queryKey: STACKS_QUERY_KEY })
    },
    onError: (err) => {
      showToast(err instanceof Error ? err.message : String(err), 'error')
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
      showToast('Stack settings updated', 'success')
    },
    onError: (err) => {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    },
  })

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm opacity-70 py-8">
        <Spinner className="size-4" />
        <span>Loading {stackName}...</span>
      </div>
    )
  }

  if (error || !detail) {
    return (
      <p className="text-sm opacity-70 py-8">
        {error ? `Failed to load: ${error.message}` : 'Stack not found in repository.'}
      </p>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between pb-3">
        <div className="flex items-center gap-3">
          <h2 className="text-xl">{stackName}</h2>
          <span className="text-xs opacity-50">{detail.host}</span>
          <span className="text-xs opacity-50">&middot;</span>
          <span className="text-xs opacity-50">
            {detail.deployMode === 'auto' ? 'Auto Deploy' : 'Manual Deploy'}
          </span>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-foreground"
                onClick={() => setSettingsDialogOpen(true)}
                aria-label="stack settings"
              />
            }
          >
            <Settings2 size={16} />
          </TooltipTrigger>
          <TooltipContent>Stack settings</TooltipContent>
        </Tooltip>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-3 border-b border-border">
        <Tabs
          value={panel}
          onValueChange={(value) => setPanel(value as 'compose' | 'secrets' | 'containers' | 'deploys')}
        >
          <TabsList>
            <TabsTrigger value="compose" className="py-2">Compose</TabsTrigger>
            <TabsTrigger value="secrets" className="py-2">Secrets</TabsTrigger>
            <TabsTrigger value="containers" className="py-2">Containers</TabsTrigger>
            <TabsTrigger value="deploys" className="py-2">Deploys</TabsTrigger>
          </TabsList>
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
                showToast('Rollback triggered successfully', 'success')
                queryClient.invalidateQueries({ queryKey: [...DEPLOY_HISTORY_QUERY_KEY, stackName] })
                queryClient.invalidateQueries({ queryKey: STACKS_QUERY_KEY })
              }}
              onRollbackError={(err) => {
                showToast(err.message, 'error')
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
      <div className="shrink-0 border-t border-(--border) bg-(--background) px-1 py-3">
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
    </div>
  )
}
