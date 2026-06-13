import { createFileRoute } from '@tanstack/react-router'
import { ManagedHostsCard } from '@/components/settings/ManagedHostsCardConnected'

export const Route = createFileRoute('/stacks/host/$hostName')({
  ssr: false,
  component: HostSettingsView,
})

function HostSettingsView() {
  const { hostName } = Route.useParams()

  return (
    <div className="max-w-2xl">
      <h6 className="text-xl font-medium mb-4">{hostName}</h6>
      <ManagedHostsCard filterHostName={hostName} />
    </div>
  )
}
