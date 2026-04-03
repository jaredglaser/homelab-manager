import { useState, useEffect } from 'react'
import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { CircularProgress, Typography } from '@mui/material'
import { listStacks, createStack, listManagedHostNames } from '@/data/stacks/functions'
import { useStackStatus } from '@/hooks/useStackStatus'
import CreateStackDialog from '@/components/stacks/CreateStackDialog'
import StackNav from '@/components/stacks/StackNav'
import { StackListContext, StackStatusContext } from '@/components/stacks/stacks-context'
import { STACKS_QUERY_KEY } from '@/lib/constants/stacks-keys'

export const Route = createFileRoute('/stacks')({
  ssr: false,
  component: StacksLayout,
})

const HOST_NAMES_QUERY_KEY = ['managed-host-names']

function StacksLayout() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const { data: stacks, isLoading: stacksLoading, error: stacksError } = useQuery({
    queryKey: STACKS_QUERY_KEY,
    queryFn: () => listStacks(),
  })

  const { data: hosts, isLoading: hostsLoading, error: hostsError } = useQuery({
    queryKey: HOST_NAMES_QUERY_KEY,
    queryFn: () => listManagedHostNames(),
  })

  const isLoading = stacksLoading || hostsLoading
  const error = stacksError ?? hostsError

  const { statusMap, deployVersion } = useStackStatus()

  // Invalidate stacks list when a deploy completes (replaces 10s polling)
  useEffect(() => {
    if (deployVersion === 0) return;
    queryClient.invalidateQueries({ queryKey: STACKS_QUERY_KEY });
  }, [deployVersion, queryClient]);

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
      setCreateError(err instanceof Error ? err.message : String(err))
    },
  })

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <Typography color="error" variant="body2">
          Failed to load stacks: {error.message}
        </Typography>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 gap-2">
        <CircularProgress size={16} />
        <Typography variant="body2" className="opacity-70">Loading stacks...</Typography>
      </div>
    )
  }

  return (
    <StackListContext value={{ stacks: stacks ?? [], hosts: hosts ?? [], isLoading }}>
      <StackStatusContext value={{ statusMap, deployVersion }}>
        <div className="flex w-full flex-1 min-h-0">
          <StackNav onCreateClick={() => { setCreateError(null); setDialogOpen(true) }} />
          <div className="flex-1 min-h-0 flex flex-col p-6">
            <Outlet />
          </div>
        </div>
        <CreateStackDialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          onSubmit={(input) => createMutation.mutate(input)}
          hosts={hosts ?? []}
          isLoading={createMutation.isPending}
          error={createError}
        />
      </StackStatusContext>
    </StackListContext>
  )
}
