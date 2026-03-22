import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import PageHeader from '@/components/PageHeader'
import { isDockerManagementEnabledClient } from '@/lib/utils/feature-flags'
import { listStacks } from '@/data/stacks/functions'
import StacksTable from '@/components/stacks/StacksTable'
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

function StacksPage() {
  const { data: stacks, isLoading, error } = useQuery({
    queryKey: STACKS_QUERY_KEY,
    queryFn: () => listStacks(),
    refetchInterval: 10_000,
  })
  const { statusMap } = useStackStatus()

  return (
    <div className="w-full p-6">
      <PageHeader title="Docker Stacks" />
      <StacksTable
        stacks={stacks ?? []}
        isLoading={isLoading}
        error={error}
        statusMap={statusMap}
      />
    </div>
  )
}
