import { useEffect } from 'react'
import { createFileRoute, Outlet } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CircularProgress, Typography } from '@mui/material'
import { listStacks, listManagedHostNames } from '@/data/stacks/functions'
import { useStackStatus } from '@/hooks/useStackStatus'
import { StackListContext, StackStatusContext } from '@/components/stacks/stacks-context'
import { STACKS_QUERY_KEY } from '@/lib/constants/stacks-keys'

export const Route = createFileRoute('/stacks')({
  ssr: false,
  component: StacksLayout,
})

const HOST_NAMES_QUERY_KEY = ['managed-host-names']

function StacksLayout() {
  const queryClient = useQueryClient()

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
        <div className="flex-1 min-h-0 flex flex-col p-6">
          <Outlet />
        </div>
      </StackStatusContext>
    </StackListContext>
  )
}
