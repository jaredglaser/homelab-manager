import { createFileRoute } from '@tanstack/react-router'
import AppShell from '../components/AppShell'
import ContainerTable from '../components/docker/ContainerTable'

export const Route = createFileRoute('/')({ ssr: false, component: DockerPage })

function DockerPage() {
  return (
    <AppShell>
      <ContainerTable />
    </AppShell>
  )
}
