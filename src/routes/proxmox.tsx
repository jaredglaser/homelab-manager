import { useState, useCallback, useEffect, useRef } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Typography, CircularProgress } from '@mui/joy'
import AppShell from '../components/AppShell'
import PageHeader from '@/components/PageHeader'
import ClusterSummaryCards from '@/components/proxmox/ClusterSummaryCards'
import NodeTable from '@/components/proxmox/NodeTable'
import GuestTable from '@/components/proxmox/GuestTable'
import StorageTable from '@/components/proxmox/StorageTable'
import { useSSE } from '@/hooks/useSSE'
import { testProxmoxConnection } from '@/data/proxmox.functions'
import type { ProxmoxClusterOverview } from '@/types/proxmox'

export const Route = createFileRoute('/proxmox')({
  ssr: false,
  component: ProxmoxPage,
})

function ProxmoxPage() {
  return (
    <AppShell>
      <div className="w-full p-6">
        <PageHeader title="Proxmox Dashboard" />
        <ProxmoxContent />
      </div>
    </AppShell>
  )
}

function ProxmoxContent() {
  const [overview, setOverview] = useState<ProxmoxClusterOverview | null>(null)
  const [configured, setConfigured] = useState<boolean | null>(null)

  const handleData = useCallback((data: ProxmoxClusterOverview) => {
    setOverview(data)
    setConfigured(true)
  }, [])

  const { isConnected, error } = useSSE<ProxmoxClusterOverview>({
    url: '/api/proxmox-overview',
    onData: handleData,
  })

  // Check configuration if connected but no data received after a delay
  const configCheckedRef = useRef(false)
  useEffect(() => {
    if (configCheckedRef.current || overview) return
    if (!isConnected) return

    configCheckedRef.current = true
    // Wait briefly — the poll service fires immediately on subscribe,
    // so if data hasn't arrived yet, Proxmox likely isn't configured
    const timer = setTimeout(() => {
      if (!overview) {
        testProxmoxConnection().then((result) => {
          if (!result.connected) {
            setConfigured(false)
          }
        })
      }
    }, 3000)

    return () => clearTimeout(timer)
  }, [isConnected, overview])

  if (error) {
    return (
      <Typography level="body-md" className="text-red-600 py-8">
        Failed to connect to Proxmox SSE stream: {error.message}
      </Typography>
    )
  }

  if (!overview) {
    if (configured === false) {
      return (
        <div className="py-8">
          <Typography level="body-md" className="mb-2">
            Proxmox is not configured.
          </Typography>
          <Typography level="body-sm" className="text-neutral-500">
            Set the following environment variables to connect to your Proxmox cluster:
          </Typography>
          <pre className="mt-3 p-4 bg-neutral-100 dark:bg-neutral-800 rounded-lg text-sm font-mono">
{`PROXMOX_HOST=your-proxmox-host
PROXMOX_TOKEN_ID=user@realm!tokenid
PROXMOX_TOKEN_SECRET=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
PROXMOX_PORT=8006              # optional, default 8006
PROXMOX_ALLOW_SELF_SIGNED=true # optional, default true`}
          </pre>
        </div>
      )
    }

    return (
      <div className="flex items-center gap-3 py-12">
        <CircularProgress size="sm" />
        <Typography level="body-md">Loading Proxmox cluster data...</Typography>
      </div>
    )
  }

  return (
    <>
      <ClusterSummaryCards overview={overview} />
      <NodeTable nodes={overview.nodes} />
      <GuestTable vms={overview.vms} containers={overview.containers} />
      <StorageTable storages={overview.storages} />
    </>
  )
}
