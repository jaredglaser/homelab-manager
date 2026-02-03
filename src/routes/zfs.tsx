import { createFileRoute } from '@tanstack/react-router'
import AppShell from '../components/AppShell'
import ZFSPoolsTable from '../components/zfs/ZFSPoolsTable'

export const Route = createFileRoute('/zfs')({
  ssr: false,
  component: ZFSPage,
})

function ZFSPage() {
  return (
    <AppShell>
      <ZFSPoolsTable />
    </AppShell>
  )
}
