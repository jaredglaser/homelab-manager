import { useCallback, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, RefreshCw, TriangleAlert } from 'lucide-react'
import { listAgentsInventory, updateAgent } from '@/data/hosts/functions'
import type { AgentInventoryEntry } from '@/data/hosts/functions'
import { useMuxChannel } from '@/lib/mux/use-mux-channel'
import { AGENT_INVENTORY_TOPIC } from '@/lib/mux/protocol'
import { agentInventoryChannel } from '@/lib/sse/channels/agent-inventory'
import { useAuth } from '@/hooks/useAuth'
import { useToast } from '@/hooks/toastAtom'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export const AGENTS_INVENTORY_QUERY_KEY = ['agents-inventory'] as const

export type AgentRowFeedback = {
  severity: 'success' | 'info' | 'error'
  message: string
}

export type AgentsOverviewProps = {
  agents: AgentInventoryEntry[]
  isLoading: boolean
  isError: boolean
  isAdmin: boolean
  busyByHost: Record<number, 'update' | undefined>
  feedbackByHost: Record<number, AgentRowFeedback>
  onUpdate: (hostId: number) => void
  onRetry: () => void
}

const STATUS_BADGE: Record<AgentInventoryEntry['status'], { label: string; variant: 'success' | 'destructive' | 'warning' | 'outline' }> = {
  online: { label: 'Online', variant: 'success' },
  offline: { label: 'Offline', variant: 'destructive' },
  unreachable: { label: 'Unreachable', variant: 'warning' },
  unknown: { label: 'Unknown', variant: 'outline' },
}

function StatusBadge({ status }: { status: AgentInventoryEntry['status'] }) {
  const { label, variant } = STATUS_BADGE[status]
  return <Badge variant={variant} className="text-[10px]">{label}</Badge>
}

function VersionCell({ agent }: { agent: AgentInventoryEntry }) {
  if (!agent.version) {
    return <span className="text-xs text-muted-foreground">unknown</span>
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-xs font-mono">v{agent.version}</span>
      {agent.versionSource === 'stored' && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge variant="outline" className="h-4 text-[10px]" aria-label="stored version">
                stored
              </Badge>
            }
          />
          <TooltipContent>Last version the agent reported; it is offline right now.</TooltipContent>
        </Tooltip>
      )}
    </span>
  )
}

function AgentRow({
  agent,
  isAdmin,
  busy,
  feedback,
  onUpdate,
}: {
  agent: AgentInventoryEntry
  isAdmin: boolean
  busy: 'update' | undefined
  feedback: AgentRowFeedback | undefined
  onUpdate: () => void
}) {
  return (
    <div className="px-4 py-3 border-b border-border last:border-0" data-testid={`agent-row-${agent.name}`}>
      <div className="flex items-center gap-3">
        <Bot size={16} className="text-muted-foreground shrink-0" aria-hidden />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold truncate">{agent.name}</p>
            <StatusBadge status={agent.status} />
            <VersionCell agent={agent} />
          </div>
          <span className="text-xs font-mono text-muted-foreground block truncate">{agent.agentUrl}</span>
          {agent.status !== 'online' && agent.lastError && (
            <p className="text-xs text-muted-foreground truncate" title={agent.lastError}>{agent.lastError}</p>
          )}
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!isAdmin || busy !== undefined}
                  onClick={onUpdate}
                  aria-label={`Update ${agent.name}`}
                />
              }
            >
              {busy === 'update' ? <Spinner className="size-3.5" /> : <RefreshCw size={14} />}
              <span className="ml-1">Update</span>
            </TooltipTrigger>
            {!isAdmin && <TooltipContent>Admins only</TooltipContent>}
          </Tooltip>
        </div>
      </div>
      {feedback && (
        <p
          role="status"
          aria-live="polite"
          className={
            feedback.severity === 'error'
              ? 'text-xs text-destructive mt-1.5'
              : feedback.severity === 'success'
                ? 'text-xs text-success mt-1.5'
                : 'text-xs text-muted-foreground mt-1.5'
          }
        >
          {feedback.message}
        </p>
      )}
    </div>
  )
}

export function AgentsOverviewView({
  agents,
  isLoading,
  isError,
  isAdmin,
  busyByHost,
  feedbackByHost,
  onUpdate,
  onRetry,
}: AgentsOverviewProps) {
  if (isLoading) {
    return (
      <div className="p-4 bg-card rounded-lg border border-border flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        Loading agents…
      </div>
    )
  }

  if (isError) {
    return (
      <Alert variant="error">
        <TriangleAlert />
        <AlertTitle>Failed to load agents</AlertTitle>
        <AlertDescription className="flex items-center gap-3">
          The agents inventory could not be fetched. Check the server logs and try again.
          <Button size="sm" variant="outline" onClick={onRetry} aria-label="Retry loading agents">
            <RefreshCw size={14} />
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  if (!agents.length) {
    return (
      <div className="p-4 bg-card rounded-lg border border-border">
        <p className="text-sm font-medium">No agents registered</p>
        <p className="text-xs text-muted-foreground mt-1">
          Add a host under Settings, then Manage Hosts to register its agent here.
        </p>
      </div>
    )
  }

  return (
    <div className="bg-card rounded-lg border border-border divide-y-0">
      {agents.map((agent) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          isAdmin={isAdmin}
          busy={busyByHost[agent.id]}
          feedback={feedbackByHost[agent.id]}
          onUpdate={() => onUpdate(agent.id)}
        />
      ))}
    </div>
  )
}

function describeUpdateResult(result: Awaited<ReturnType<typeof updateAgent>>): AgentRowFeedback {
  if (result.healthy && result.version) {
    return { severity: 'success', message: `Update confirmed, agent now on v${result.version}` }
  }
  if (result.healthy) {
    return { severity: 'success', message: 'Update succeeded, agent is healthy' }
  }
  if (result.error?.includes('latest version already')) {
    return { severity: 'info', message: 'Agent is already on the latest version' }
  }
  if (result.error?.includes('already in progress')) {
    return { severity: 'info', message: 'An update is already in progress for this agent' }
  }
  return {
    severity: 'error',
    message: result.error ?? 'Update failed',
  }
}

export default function AgentsOverview() {
  const queryClient = useQueryClient()
  const { showToast } = useToast()
  const { user, loading: authLoading, authEnabled } = useAuth()
  const isAdmin = !authLoading && (!authEnabled || user?.role === 'admin')
  const [busyByHost, setBusyByHost] = useState<Record<number, 'update' | undefined>>({})
  const [feedbackByHost, setFeedbackByHost] = useState<Record<number, AgentRowFeedback>>({})

  const { data: agents = [], isLoading, isError } = useQuery({
    queryKey: AGENTS_INVENTORY_QUERY_KEY,
    queryFn: () => listAgentsInventory(),
  })

  // Subscribes on mount, unsubscribes on unmount/route change: the worker sweep
  // publishes a fresh snapshot over the mux, so the table updates without polling.
  useMuxChannel({ ...agentInventoryChannel, topic: AGENT_INVENTORY_TOPIC }, {
    onData: useCallback(
      (snapshot: { entries: AgentInventoryEntry[] }) => {
        queryClient.setQueryData(AGENTS_INVENTORY_QUERY_KEY, snapshot.entries)
      },
      [queryClient],
    ),
    serviceErrorMessage: 'Agent inventory stream unavailable',
  })

  const updateMutation = useMutation({
    mutationFn: (hostId: number) => updateAgent({ data: { hostId } }),
    onMutate: (hostId) => {
      setBusyByHost((prev) => ({ ...prev, [hostId]: 'update' }))
      setFeedbackByHost((prev) => {
        if (!(hostId in prev)) return prev
        const next = { ...prev }
        delete next[hostId]
        return next
      })
    },
    onSuccess: (result, hostId) => {
      setBusyByHost(({ [hostId]: _done, ...rest }) => rest)
      void queryClient.invalidateQueries({ queryKey: AGENTS_INVENTORY_QUERY_KEY })
      const feedback = describeUpdateResult(result)
      setFeedbackByHost((prev) => ({ ...prev, [hostId]: feedback }))
      if (feedback.severity === 'error') showToast(feedback.message, 'error')
    },
    onError: (err: unknown, hostId) => {
      setBusyByHost(({ [hostId]: _done, ...rest }) => rest)
      const message = err instanceof Error ? err.message : 'Update failed'
      setFeedbackByHost((prev) => ({ ...prev, [hostId]: { severity: 'error', message } }))
      showToast(message, 'error')
    },
  })

  return (
    <div className="flex flex-col gap-4 max-w-2xl px-4 pb-6">
      <AgentsOverviewView
        agents={agents}
        isLoading={isLoading}
        isError={isError}
        isAdmin={isAdmin}
        busyByHost={busyByHost}
        feedbackByHost={feedbackByHost}
        onUpdate={(hostId) => updateMutation.mutate(hostId)}
        onRetry={() => void queryClient.invalidateQueries({ queryKey: AGENTS_INVENTORY_QUERY_KEY })}
      />
    </div>
  )
}
