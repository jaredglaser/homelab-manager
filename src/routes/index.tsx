import { createFileRoute } from '@tanstack/react-router'
import AppShell from '../components/AppShell'
import ContainerTable from '../components/docker/ContainerTable'
import PageHeader from '@/components/PageHeader'

export const Route = createFileRoute('/')({ ssr: false, component: DockerPage })

function DockerPage() {
  return (
    <AppShell>
      <div className="w-full p-6">
        <PageHeader title="Docker Containers Dashboard" />
        <ContainerTable />
      </div>
    </AppShell>
  )
}
