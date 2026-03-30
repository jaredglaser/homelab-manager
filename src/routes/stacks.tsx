import { useState } from 'react'
import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listStacks, createStack, listManagedHostNames } from '@/data/stacks/functions'
import { useStackStatus } from '@/hooks/useStackStatus'
import CreateStackDialog from '@/components/stacks/CreateStackDialog'
import StackNav from '@/components/stacks/StackNav'
import { StacksContext } from '@/components/stacks/stacks-context'
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

  const { data: stacks = [], isLoading } = useQuery({
    queryKey: STACKS_QUERY_KEY,
    queryFn: () => listStacks(),
    refetchInterval: 10_000,
  })

  const { data: hosts = [] } = useQuery({
    queryKey: HOST_NAMES_QUERY_KEY,
    queryFn: () => listManagedHostNames(),
  })

  const { statusMap } = useStackStatus()

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

  return (
    <StacksContext value={{ stacks, statusMap, hosts, isLoading }}>
      <div className="flex w-full h-[calc(100vh-64px)]">
        <StackNav onCreateClick={() => { setCreateError(null); setDialogOpen(true) }} />
        <div className="flex-1 min-h-0 flex flex-col p-6">
          <Outlet />
        </div>
      </div>
      <CreateStackDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={(input) => createMutation.mutate(input)}
        hosts={hosts}
        isLoading={createMutation.isPending}
        error={createError}
      />
    </StacksContext>
  )
}
