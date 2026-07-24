import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Server, Layers, Plus } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useStackListContext, useStackStatusContext } from '@/components/stacks/stacks-context'
import CreateStackDialog from '@/components/stacks/CreateStackDialog'
import StackDriftSummary from '@/components/stacks/StackDriftSummary'
import { createStack, scanDrift } from '@/data/stacks/functions'
import { STACKS_QUERY_KEY, STACK_DRIFT_QUERY_KEY } from '@/lib/constants/stacks-keys'

export default function StacksOverview() {
  const { stacks, hosts, isLoading } = useStackListContext()
  const { statusMap } = useStackStatusContext()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const { data: driftReport, isLoading: driftLoading, refetch: refetchDrift } = useQuery({
    queryKey: STACK_DRIFT_QUERY_KEY,
    queryFn: () => scanDrift(),
    // Each scan fans out an HTTP call per docker host, so keep the result warm
    // across route swaps; Refresh forces a fresh scan.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })

  const hostSummaries = useMemo(() => {
    const byHost = new Map<string, { total: number; running: number }>();
    for (const stack of stacks) {
      const entry = byHost.get(stack.host) ?? { total: 0, running: 0 };
      entry.total++;
      const statusKey = `${stack.host}/${stack.name}`;
      const status = statusMap.get(statusKey);
      if (status && status.containers.some(c => c.status === 'running')) {
        entry.running++;
      }
      byHost.set(stack.host, entry);
    }
    return Array.from(byHost.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([host, counts]) => ({ host, ...counts }));
  }, [stacks, statusMap])

  const createMutation = useMutation({
    mutationFn: (input: { stackName: string; host: string; autoDeploy: boolean }) =>
      createStack({ data: input }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: STACKS_QUERY_KEY })
      setDialogOpen(false)
      setCreateError(null)
      navigate({ to: '/stacks/$stackName', params: { stackName: variables.stackName } })
    },
    onError: (err) => {
      console.error('Stack creation failed:', err)
      setCreateError(err instanceof Error ? err.message : String(err))
    },
  })

  function openDialog() {
    setCreateError(null)
    setDialogOpen(true)
  }

  const dialog = (
    <CreateStackDialog
      open={dialogOpen}
      onClose={() => setDialogOpen(false)}
      onSubmit={(input) => createMutation.mutate(input)}
      hosts={hosts}
      isLoading={createMutation.isPending}
      error={createError}
    />
  )

  const driftSummary = (
    <StackDriftSummary
      report={driftReport}
      isLoading={driftLoading}
      onRefresh={() => { void refetchDrift() }}
    />
  )

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 opacity-50">
        <p className="text-sm">Loading stacks...</p>
      </div>
    )
  }

  if (stacks.length === 0) {
    return (
      <>
        {driftSummary}
        <div className="flex flex-col items-center justify-center h-64 gap-3">
          <Layers size={40} className="opacity-20" />
          <p className="text-base opacity-50">No stacks yet.</p>
          <Button variant="outline" size="sm" onClick={openDialog}>
            <Plus size={14} />
            New stack
          </Button>
        </div>
        {dialog}
      </>
    )
  }

  return (
    <>
      <div className="max-w-lg">
        {driftSummary}
        <div className="flex items-center justify-between mb-4">
          <h6 className="text-xl font-medium">Stacks Overview</h6>
          <Button variant="outline" size="sm" onClick={openDialog}>
            <Plus size={14} />
            New stack
          </Button>
        </div>
        <div className="flex flex-col gap-3">
          {hostSummaries.map(({ host, total, running }) => (
            <div
              key={host}
              className="flex items-center gap-3 px-4 py-3 bg-card rounded-lg border border-border"
            >
              <Server size={18} className="opacity-50" />
              <div className="flex-1">
                <p className="text-sm font-medium">{host}</p>
                <span className="text-xs opacity-60">
                  {total} {total === 1 ? 'stack' : 'stacks'} &middot; {running} running
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
      {dialog}
    </>
  )
}
