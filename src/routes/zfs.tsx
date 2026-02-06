import { createFileRoute } from '@tanstack/react-router'
import AppShell from '../components/AppShell'
import ZFSPoolsTable from '../components/zfs/ZFSPoolsTable'
import PageHeader from '@/components/PageHeader'

export const Route = createFileRoute('/zfs')({
  ssr: false,
  component: ZFSPage,
})

function ZFSPage() {
  return (
    <AppShell>
      <div className="w-full p-6">
        <PageHeader title="ZFS Pools Dashboard" />
        <ZFSPoolsTable />
      </div>
    </AppShell>
  )
}
