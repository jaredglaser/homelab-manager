import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@mui/material'
import { Plus } from 'lucide-react'
import PageHeader from '@/components/PageHeader'
import { isDockerManagementEnabledClient } from '@/lib/utils/feature-flags'
import { listStacks, createStack, listManagedHostNames } from '@/data/stacks.functions'
import StacksTable from '@/components/stacks/StacksTable'
import CreateStackDialog from '@/components/stacks/CreateStackDialog'
import { STACKS_QUERY_KEY } from '@/lib/constants/stacks-keys'
import { useStackStatus } from '@/hooks/useStackStatus'

export const Route = createFileRoute('/stacks')({
  ssr: false,
  component: StacksPageContent,
})

function StacksPageContent() {
  if (!isDockerManagementEnabledClient()) {
    return (
      <div className="w-full p-6">
        <PageHeader title="Docker Stacks" />
        <p className="text-sm opacity-70">Docker management is not enabled.</p>
      </div>
    )
  }

  return <StacksPage />
}

const HOST_NAMES_QUERY_KEY = ['managed-host-names']

function StacksPage() {
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const { data: stacks, isLoading, error } = useQuery({
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: STACKS_QUERY_KEY })
      setDialogOpen(false)
    },
    onError: (err) => {
      setCreateError(err instanceof Error ? err.message : String(err))
    },
  })

  return (
    <div className="w-full p-6">
      <PageHeader title="Docker Stacks">
        <div className="flex justify-end mt-2">
          <Button
            variant="contained"
            startIcon={<Plus size={16} />}
            onClick={() => { setCreateError(null); setDialogOpen(true) }}
          >
            Create Stack
          </Button>
        </div>
      </PageHeader>
      <StacksTable
        stacks={stacks ?? []}
        isLoading={isLoading}
        error={error}
        statusMap={statusMap}
      />
      <CreateStackDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={(input) => createMutation.mutate(input)}
        hosts={hosts}
        isLoading={createMutation.isPending}
        error={createError}
      />
    </div>
  )
}
