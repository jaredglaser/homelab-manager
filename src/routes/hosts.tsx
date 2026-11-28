import { createFileRoute } from '@tanstack/react-router'
import PageTitle from '@/components/PageTitle'
import AgentsOverview from '@/components/agents/AgentsOverview'
import ZfsNodesCard from '@/components/zfs-nodes/ZfsNodesCard'

export const Route = createFileRoute('/hosts')({
  ssr: false,
  component: HostsPageContent,
})

function HostsPageContent() {
  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
      <PageTitle title="Hosts" />
      <AgentsOverview />
      <ZfsNodesCard />
    </div>
  )
}
