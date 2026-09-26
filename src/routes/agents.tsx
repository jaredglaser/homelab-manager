import { createFileRoute } from '@tanstack/react-router'
import PageTitle from '@/components/PageTitle'
import AgentsOverview from '@/components/agents/AgentsOverview'

export const Route = createFileRoute('/agents')({
  ssr: false,
  component: AgentsPageContent,
})

function AgentsPageContent() {
  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
      <PageTitle title="Agents" />
      <AgentsOverview />
    </div>
  )
}
