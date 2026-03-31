import { createFileRoute } from '@tanstack/react-router'
import { Typography } from '@mui/material'
import { ManagedHostsCard } from '@/components/settings/ManagedHostsCardConnected'

export const Route = createFileRoute('/stacks/host/$hostName')({
  ssr: false,
  component: HostSettingsView,
})

function HostSettingsView() {
  const { hostName } = Route.useParams()

  return (
    <div className="max-w-2xl">
      <Typography variant="h6" className="mb-4">{hostName}</Typography>
      <ManagedHostsCard filterHostName={hostName} />
    </div>
  )
}
