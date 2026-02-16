import { createFileRoute } from '@tanstack/react-router'
import AppShell from '../components/AppShell'
import ProxmoxClusterTable from '../components/proxmox/ProxmoxClusterTable'
import IPOverview from '../components/proxmox/IPOverview'
import ReplicationTable from '../components/proxmox/ReplicationTable'
import PageHeader from '@/components/PageHeader'
import { useStreamingData } from '@/hooks/useStreamingData'
import type { ProxmoxStatsFromDB } from '@/lib/transformers/proxmox-transformer'
import { useCallback } from 'react'

export const Route = createFileRoute('/proxmox')({
  ssr: false,
  component: ProxmoxPage,
})

function ProxmoxPage() {
  const transform = useCallback(
    (raw: ProxmoxStatsFromDB[]) => raw,
    [],
  );

  const { state: stats } = useStreamingData<ProxmoxStatsFromDB[], ProxmoxStatsFromDB[]>({
    url: '/api/proxmox-stats',
    transform,
    initialState: [],
    staleKey: 'proxmox-page',
  });

  return (
    <AppShell>
      <div className="w-full p-6">
        <PageHeader title="Proxmox Cluster" />
        <ProxmoxClusterTable />
        <IPOverview stats={stats} />
        <ReplicationTable stats={stats} />
      </div>
    </AppShell>
  )
}
