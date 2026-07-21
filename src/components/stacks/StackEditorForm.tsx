import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useBlocker } from '@tanstack/react-router'
import { FormProvider, useForm, useFormState } from 'react-hook-form'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Settings2 } from 'lucide-react'
import { useStackStatusContext } from '@/components/stacks/stacks-context'
import { useToast } from '@/hooks/toastAtom'
import {
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
import UnsavedChangesDialog from '@/components/stacks/UnsavedChangesDialog'
import { STACKS_QUERY_KEY, DEPLOY_HISTORY_QUERY_KEY } from '@/lib/constants/stacks-keys'
import { parseVariables } from '@/lib/stacks/parse-variables'
import type { StackDetail } from '@/types/stacks'
import type { StackFormValues } from '@/components/stacks/stack-form'

type Panel = 'compose' | 'secrets' | 'containers' | 'deploys'

interface StackEditorFormProps {
  stackName: string
  detail: StackDetail
}

function TabDirtyDot() {
  return (
    <span
      aria-label="unsaved changes"
      className="ml-1.5 inline-block size-1.5 rounded-full bg-primary align-middle"
    />
  )
}

/**
 * Loaded stack editor. Owns the single react-hook-form instance backing the
 * compose draft and secret values; it is mounted with `key={stackName}` by the
 * route so switching stacks starts a clean form. A tab dot marks per-tab unsaved
 * state and `useBlocker` warns before navigation that would drop in-memory edits.
 */
export default function StackEditorForm({ stackName, detail }: Readonly<StackEditorFormProps>) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { statusMap, deployVersion } = useStackStatusContext()
  const { showToast } = useToast()

  const [panel, setPanel] = useState<Panel>('compose')
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false)
  const [forceRecreate, setForceRecreate] = useState(false)

  const form = useForm<StackFormValues>({
    defaultValues: { compose: detail.composeContent, secrets: {} },
  })
  const { isDirty, dirtyFields } = useFormState({ control: form.control })
  const composeDirty = !!dirtyFields.compose
  const secretsDirty = Object.values(dirtyFields.secrets ?? {}).some(Boolean)

  // Adopt a new saved compose (background refetch, or an external edit) only when
  // the user hasn't diverged, so an in-progress draft is never overwritten.
  useEffect(() => {
    if (!form.getFieldState('compose').isDirty) {
      form.resetField('compose', { defaultValue: detail.composeContent })
    }
  }, [detail.composeContent, form])

  // Leave-guard. `useBlocker` intercepts router navigation; the beforeunload hook
  // covers browser refresh/close. Delete flips `bypassRef` so removing the stack
  // (which discards edits by design) isn't gated by the prompt.
  const isDirtyRef = useRef(isDirty)
  isDirtyRef.current = isDirty
  const bypassRef = useRef(false)
  const blocker = useBlocker({
    shouldBlockFn: () => !bypassRef.current && isDirtyRef.current,
    enableBeforeUnload: () => isDirtyRef.current,
    withResolver: true,
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

  const composeVars = useMemo(() => parseVariables(detail.composeContent), [detail.composeContent])

  const statusKey = `${detail.host}/${detail.name}`
  const containers = statusMap.get(statusKey)?.containers ?? []

  const deployMutation = useMutation({
    mutationFn: (action: 'deploy' | 'teardown') =>
      triggerDeploy({ data: { stack: stackName, host: detail.host, action, forceRecreate: action === 'deploy' ? forceRecreate : undefined } }),
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
    // isn't held up waiting for the agent. Bypass the unsaved-changes guard
    // since deleting the stack intentionally discards any in-progress edits.
    bypassRef.current = true
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

  return (
    <FormProvider {...form}>
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
          <Tabs value={panel} onValueChange={(value) => setPanel(value as Panel)}>
            <TabsList>
              <TabsTrigger value="compose" className="py-2">
                Compose{composeDirty && <TabDirtyDot />}
              </TabsTrigger>
              <TabsTrigger value="secrets" className="py-2">
                Secrets{secretsDirty && <TabDirtyDot />}
              </TabsTrigger>
              <TabsTrigger value="containers" className="py-2">Containers</TabsTrigger>
              <TabsTrigger value="deploys" className="py-2">Deploys</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* Tab content, scrollable */}
        <div className="flex-1 overflow-y-auto themed-scrollbar">
          <div className="flex flex-col gap-4 py-4">
            {panel === 'compose' && (
              <ComposeEditorLoader stackName={stackName} />
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
        <UnsavedChangesDialog
          open={blocker.status === 'blocked'}
          onDiscard={() => { if (blocker.status === 'blocked') blocker.proceed() }}
          onKeepEditing={() => { if (blocker.status === 'blocked') blocker.reset() }}
        />
      </div>
    </FormProvider>
  )
}
