import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Button, Paper, Typography } from '@mui/material'
import { Server, Layers, Plus } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useStackListContext, useStackStatusContext } from '@/components/stacks/stacks-context'
import CreateStackDialog from '@/components/stacks/CreateStackDialog'
import { createStack } from '@/data/stacks/functions'
import { STACKS_QUERY_KEY } from '@/lib/constants/stacks-keys'

export default function StacksOverview() {
  const { stacks, hosts, isLoading } = useStackListContext()
  const { statusMap } = useStackStatusContext()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 opacity-50">
        <Typography variant="body2">Loading stacks...</Typography>
      </div>
    )
  }

  if (stacks.length === 0) {
    return (
      <>
        <div className="flex flex-col items-center justify-center h-64 gap-3">
          <Layers size={40} className="opacity-20" />
          <Typography variant="body1" className="opacity-50">No stacks yet.</Typography>
          <Button variant="outlined" size="small" startIcon={<Plus size={14} />} onClick={openDialog}>
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
        <div className="flex items-center justify-between mb-4">
          <Typography variant="h6">Stacks Overview</Typography>
          <Button variant="outlined" size="small" startIcon={<Plus size={14} />} onClick={openDialog}>
            New stack
          </Button>
        </div>
        <div className="flex flex-col gap-3">
          {hostSummaries.map(({ host, total, running }) => (
            <Paper
              key={host}
              variant="outlined"
              className="flex items-center gap-3 px-4 py-3"
            >
              <Server size={18} className="opacity-50" />
              <div className="flex-1">
                <Typography variant="body2" className="font-medium">{host}</Typography>
                <Typography variant="caption" className="opacity-60">
                  {total} {total === 1 ? 'stack' : 'stacks'} &middot; {running} running
                </Typography>
              </div>
            </Paper>
          ))}
        </div>
      </div>
      {dialog}
    </>
  )
}
