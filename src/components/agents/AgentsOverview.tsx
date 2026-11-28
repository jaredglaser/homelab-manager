import { useCallback, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Server, TriangleAlert } from 'lucide-react'
import { listAgentsInventory, updateAgent } from '@/data/hosts/functions'
import type { AgentInventoryEntry, UpdateAgentResult } from '@/data/hosts/functions'
import type { AgentUpdateResult } from '@/lib/hosts/agent-inventory'
import { updateFailureMessage } from '@/lib/errors/agent-route-failure-copy'
import { hostFailureDetail, hostFailureMessage } from '@/lib/errors/host-failure-copy'
import { serverFnErrorMessage } from '@/lib/errors/server-fn-error-copy'
import { useMuxChannel } from '@/lib/mux/use-mux-channel'
import { agentInventoryChannel } from '@/lib/channels/agent-inventory'
import { useToast } from '@/hooks/toastAtom'
import { AGENT_ZFS_MOVED_MESSAGE, agentNeedsZfsNode, type ZfsNodeSummary } from '@/lib/zfs/node-state'
import { useZfsNodes } from '@/hooks/useZfsNodes'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export const AGENTS_INVENTORY_QUERY_KEY = ['agents-inventory'] as const

export const AGENT_UPDATE_AVAILABLE_MESSAGE =
  'A newer agent image is available for this host. Select Update agent to apply it.'

export const AGENT_STORED_VERSION_MESSAGE =
  'Last version the agent reported. It is not online right now, so this may be out of date.'

export const AGENT_UPDATE_RUNNING_MESSAGE = 'Updating the agent. This takes up to a minute.'

export const AGENT_UPDATE_INTERRUPTED_MESSAGE =
  "The dashboard restarted during this update, so its result was not recorded. Check the agent's version here, and update again if it did not change."

export const AGENT_UPDATE_ERRORED_MESSAGE =
  "The update stopped with an error before its result was known. Check the agent's version here, and update again if it did not change."

export type AgentRowFeedback = {
  severity: 'success' | 'info' | 'error'
  message: string
}

export type AgentsOverviewProps = {
  agents: AgentInventoryEntry[]
  isLoading: boolean
  isError: boolean
  busyByHost: Record<number, 'update' | undefined>
  feedbackByHost: Record<number, AgentRowFeedback>
  onUpdate: (hostId: number) => void
  onRetry: () => void
  zfsNodes?: readonly Pick<ZfsNodeSummary, 'name' | 'address'>[]
}

const STATUS_BADGE: Record<AgentInventoryEntry['status'], { label: string; variant: 'success' | 'destructive' | 'warning' | 'outline' }> = {
  online: { label: 'Online', variant: 'success' },
  offline: { label: 'Offline', variant: 'destructive' },
  unreachable: { label: 'Unreachable', variant: 'warning' },
  'awaiting-enrollment': { label: 'Awaiting enrollment', variant: 'warning' },
  unknown: { label: 'Unknown', variant: 'outline' },
}

function UpdateAvailableBadge() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge variant="warning" className="h-4 text-[10px]" aria-label="agent update available">
            agent update available
          </Badge>
        }
      />
      <TooltipContent>{AGENT_UPDATE_AVAILABLE_MESSAGE}</TooltipContent>
    </Tooltip>
  )
}

function StatusBadge({ status }: { status: AgentInventoryEntry['status'] }) {
  const { label, variant } = STATUS_BADGE[status]
  return <Badge variant={variant} className="text-[10px]">{label}</Badge>
}

function VersionCell({ agent }: { agent: AgentInventoryEntry }) {
  if (!agent.version) {
    return <span className="text-xs text-muted-foreground">Agent version unknown</span>
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-xs font-mono whitespace-nowrap">Agent v{agent.version}</span>
      {agent.status !== 'online' && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge variant="outline" className="h-4 text-[10px]" aria-label="stored version">
                stored
              </Badge>
            }
          />
          <TooltipContent>{AGENT_STORED_VERSION_MESSAGE}</TooltipContent>
        </Tooltip>
      )}
    </span>
  )
}

function AgentFailure({ failure }: { failure: NonNullable<AgentInventoryEntry['failure']> }) {
  const detail = hostFailureDetail(failure.code, failure.message)
  return (
    <>
      <p className="text-xs text-muted-foreground break-words">{hostFailureMessage(failure.code)}</p>
      {detail && (
        <p className="text-xs font-mono text-muted-foreground line-clamp-2 break-words" title={detail}>{detail}</p>
      )}
    </>
  )
}

function AgentRow({
  agent,
  busy,
  feedback,
  needsZfsNode,
  onUpdate,
}: {
  agent: AgentInventoryEntry
  busy: 'update' | undefined
  feedback: AgentRowFeedback | undefined
  needsZfsNode: boolean
  onUpdate: () => void
}) {
  return (
    <div className="px-4 py-3 border-b border-border last:border-0" data-testid={`agent-row-${agent.name}`}>
      <div className="flex flex-wrap items-center gap-3">
        <Server size={16} className="text-muted-foreground shrink-0" aria-hidden />
        <div className="flex-1 min-w-48">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-sm font-semibold truncate">{agent.name}</p>
            <StatusBadge status={agent.status} />
            <VersionCell agent={agent} />
            {agent.agentOutOfDate && <UpdateAvailableBadge />}
          </div>
          <span className="text-xs font-mono text-muted-foreground block truncate">{agent.agentUrl}</span>
          {agent.status !== 'online' && agent.failure && <AgentFailure failure={agent.failure} />}
          {needsZfsNode && (
            <p className="text-xs text-muted-foreground break-words" data-testid={`agent-zfs-moved-${agent.name}`}>{AGENT_ZFS_MOVED_MESSAGE}</p>
          )}
        </div>
        <div className="flex items-center gap-4 shrink-0 ml-auto">
          <Button
            requires="admin"
            size="sm"
            variant="outline"
            disabled={busy !== undefined}
            onClick={onUpdate}
            aria-label={`Update agent on ${agent.name}`}
          >
            {busy === 'update' ? <Spinner className="size-3.5" /> : <RefreshCw size={14} />}
            <span className="ml-1">Update agent</span>
          </Button>
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
  busyByHost,
  feedbackByHost,
  onUpdate,
  onRetry,
  zfsNodes = [],
}: AgentsOverviewProps) {
  if (isLoading) {
    return (
      <div className="p-4 bg-card rounded-lg border border-border flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        Loading hosts…
      </div>
    )
  }

  if (isError) {
    return (
      <Alert variant="error">
        <TriangleAlert />
        <AlertTitle>Failed to load hosts</AlertTitle>
        <AlertDescription className="flex items-center gap-3">
          The host list could not be fetched. Check the server logs and try again.
          <Button size="sm" variant="outline" onClick={onRetry} aria-label="Retry loading hosts">
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
        <p className="text-sm font-medium">No hosts registered</p>
        <p className="text-xs text-muted-foreground mt-1">
          Add a host under Settings, then Managed Hosts, and it will appear here.
        </p>
      </div>
    )
  }

  const outOfDateCount = agents.filter((agent) => agent.agentOutOfDate).length

  return (
    <div className="bg-card rounded-lg border border-border">
      {outOfDateCount > 0 && (
        <Alert variant="warning" className="mb-3" data-testid="agent-update-available-callout">
          <TriangleAlert />
          <AlertTitle>
            Agent update available on {outOfDateCount === 1 ? '1 host' : `${outOfDateCount} hosts`}
          </AlertTitle>
          <AlertDescription>{AGENT_UPDATE_AVAILABLE_MESSAGE}</AlertDescription>
        </Alert>
      )}
      {agents.map((agent) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          busy={busyByHost[agent.id]}
          feedback={feedbackByHost[agent.id]}
          needsZfsNode={agentNeedsZfsNode(agent, zfsNodes)}
          onUpdate={() => onUpdate(agent.id)}
        />
      ))}
    </div>
  )
}

function isUpdateResult(value: unknown): value is UpdateAgentResult {
  if (typeof value !== 'object' || value === null || !('healthy' in value)) return false
  if (!('at' in value) || typeof value.at !== 'string') return false
  if (value.healthy === true) return 'outcome' in value && value.outcome === 'started'
  return value.healthy === false && 'code' in value && value.code === 'update_already_running'
}

function describeUpdateResult(result: AgentUpdateResult): AgentRowFeedback {
  if (result.healthy && result.outcome === 'already_current') {
    return { severity: 'info', message: 'Already up to date. The agent runs the latest image, so nothing was changed.' }
  }
  if (result.healthy && result.version) {
    return { severity: 'success', message: `Update confirmed, agent now on v${result.version}` }
  }
  if (result.healthy) {
    return { severity: 'success', message: 'Update confirmed, agent restarted on the new image' }
  }
  return {
    severity: 'error',
    message: updateFailureMessage(result.code, result.message),
  }
}

const UPDATE_CALL_FAILED_MESSAGE = "Couldn't start the update. Reload the page and try again."

/** `at` is server time only: a browser clock would misorder it against the row's update. */
type TimedFeedback = AgentRowFeedback & { at: string }

/** A finished update only shows when it ended after this tab first saw the row, so a reload shows the row as usual. */
function rowUpdateFeedback(agent: AgentInventoryEntry, baselineAt: string | null): TimedFeedback | null {
  const update = agent.update
  if (!update) return null
  if (update.state === 'running') return { severity: 'info', message: AGENT_UPDATE_RUNNING_MESSAGE, at: update.at }
  if (update.at === baselineAt) return null
  if (update.state === 'interrupted') return { severity: 'error', message: AGENT_UPDATE_INTERRUPTED_MESSAGE, at: update.at }
  if (update.state === 'errored') return { severity: 'error', message: AGENT_UPDATE_ERRORED_MESSAGE, at: update.at }
  return { ...describeUpdateResult(update.result), at: update.at }
}

/** The toast an update owes the tab that started it, once it has ended after `startedAt`. Undefined while it has not ended. */
function endedUpdateToast(entry: AgentInventoryEntry | undefined, startedAt: string): string | null | undefined {
  const update = entry?.update
  if (!update || update.state === 'running' || update.at <= startedAt) return undefined
  if (update.state === 'errored') return AGENT_UPDATE_ERRORED_MESSAGE
  if (update.state === 'done' && !update.result.healthy) return describeUpdateResult(update.result).message
  return null
}

function withRunningUpdate(entries: AgentInventoryEntry[] | undefined, hostId: number, at: string) {
  return entries?.map((entry) =>
    entry.id === hostId && (entry.update === null || entry.update.at < at) ? { ...entry, update: { state: 'running' as const, at } } : entry,
  )
}

export default function AgentsOverview() {
  const queryClient = useQueryClient()
  const { showToast } = useToast()
  const [pendingByHost, setPendingByHost] = useState<Partial<Record<number, true>>>({})
  const [localByHost, setLocalByHost] = useState<Partial<Record<number, TimedFeedback>>>({})
  const [baselineByHost, setBaselineByHost] = useState<Partial<Record<number, string | null>>>({})
  const startedHereRef = useRef<Partial<Record<number, string>>>({})

  const recordBaseline = useCallback((entries: AgentInventoryEntry[]) => {
    setBaselineByHost((prev) => {
      const unseen = entries.filter((entry) => !(entry.id in prev))
      return unseen.length === 0 ? prev : { ...prev, ...Object.fromEntries(unseen.map((entry) => [entry.id, entry.update?.at ?? null])) }
    })
  }, [])

  const { data: zfsNodes = [] } = useZfsNodes()
  const { data: agents = [], isLoading, isError } = useQuery({
    queryKey: AGENTS_INVENTORY_QUERY_KEY,
    queryFn: async () => {
      const entries = await listAgentsInventory()
      recordBaseline(entries)
      return entries
    },
  })

  // The worker sweep publishes a fresh snapshot over the WebSocket, so the table updates without polling.
  useMuxChannel(agentInventoryChannel, {
    onData: useCallback(
      (snapshot: { entries: AgentInventoryEntry[] }) => {
        recordBaseline(snapshot.entries)
        queryClient.setQueryData(AGENTS_INVENTORY_QUERY_KEY, snapshot.entries)
        for (const entry of snapshot.entries) {
          const startedAt = startedHereRef.current[entry.id]
          const toast = startedAt === undefined ? undefined : endedUpdateToast(entry, startedAt)
          if (toast === undefined) continue
          delete startedHereRef.current[entry.id]
          if (toast !== null) showToast(toast, 'error')
        }
      },
      [queryClient, recordBaseline, showToast],
    ),
    serviceErrorMessage: 'Agent inventory stream unavailable',
  })

  const busyByHost: Record<number, 'update' | undefined> = {}
  const feedbackByHost: Record<number, AgentRowFeedback> = {}
  for (const agent of agents) {
    const baselineAt = agent.id in baselineByHost ? (baselineByHost[agent.id] ?? null) : (agent.update?.at ?? null)
    const fromRow = rowUpdateFeedback(agent, baselineAt)
    const local = localByHost[agent.id]
    const shown = local && (!fromRow || local.at >= fromRow.at) ? local : fromRow
    if (shown) feedbackByHost[agent.id] = { severity: shown.severity, message: shown.message }
    if (pendingByHost[agent.id] || agent.update?.state === 'running') busyByHost[agent.id] = 'update'
  }

  const setLocal = (hostId: number, feedback: TimedFeedback) => setLocalByHost((prev) => ({ ...prev, [hostId]: feedback }))
  const currentEntry = (hostId: number) =>
    queryClient.getQueryData<AgentInventoryEntry[]>(AGENTS_INVENTORY_QUERY_KEY)?.find((entry) => entry.id === hostId)

  const updateMutation = useMutation({
    mutationFn: async (hostId: number) => {
      const result = await updateAgent({ data: { hostId } })
      // The fetcher resolves a non-Start response (a proxy or login page) as the result instead of rejecting.
      if (!isUpdateResult(result)) throw new Error('The update call answered with something other than an update result', { cause: result })
      return result
    },
    onMutate: (hostId) => {
      setPendingByHost((prev) => ({ ...prev, [hostId]: true }))
      setLocalByHost(({ [hostId]: _cleared, ...rest }) => rest)
      const shownAt = currentEntry(hostId)?.update?.at ?? null
      setBaselineByHost((prev) => ({ ...prev, [hostId]: shownAt }))
    },
    onSuccess: (result, hostId) => {
      setPendingByHost(({ [hostId]: _done, ...rest }) => rest)
      if (result.healthy) {
        // The result can reach this tab on the live channel before this answer does.
        const toast = endedUpdateToast(currentEntry(hostId), result.at)
        if (toast === undefined) {
          queryClient.setQueryData<AgentInventoryEntry[]>(AGENTS_INVENTORY_QUERY_KEY, (entries) => withRunningUpdate(entries, hostId, result.at))
          startedHereRef.current[hostId] = result.at
        } else if (toast !== null) {
          showToast(toast, 'error')
        }
        return
      }
      void queryClient.invalidateQueries({ queryKey: AGENTS_INVENTORY_QUERY_KEY })
      const message = updateFailureMessage(result.code, result.message)
      setLocal(hostId, { severity: 'error', message, at: result.at })
      showToast(message, 'error')
    },
    onError: (err: unknown, hostId) => {
      setPendingByHost(({ [hostId]: _done, ...rest }) => rest)
      const message = serverFnErrorMessage(err, UPDATE_CALL_FAILED_MESSAGE)
      setLocal(hostId, { severity: 'error', message, at: currentEntry(hostId)?.update?.at ?? '' })
      showToast(message, 'error')
    },
  })

  return (
    <div className="flex flex-col gap-4 max-w-2xl px-4 pb-6">
      <AgentsOverviewView
        agents={agents}
        isLoading={isLoading}
        isError={isError}
        busyByHost={busyByHost}
        feedbackByHost={feedbackByHost}
        onUpdate={(hostId) => updateMutation.mutate(hostId)}
        onRetry={() => void queryClient.invalidateQueries({ queryKey: AGENTS_INVENTORY_QUERY_KEY })}
        zfsNodes={zfsNodes}
      />
    </div>
  )
}
