import { useState, useCallback, useEffect, useRef } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Typography, CircularProgress, IconButton, Tooltip, Chip, Sheet } from '@mui/joy'
import { Zap, Waves } from 'lucide-react'
import AppShell from '../components/AppShell'
import PageHeader from '@/components/PageHeader'
import ClusterSummaryCards from '@/components/proxmox/ClusterSummaryCards'
import ProxmoxHostView from '@/components/proxmox/ProxmoxHostView'
import { useSSE } from '@/hooks/useSSE'
import { testProxmoxConnection } from '@/data/proxmox.functions'
import type { ProxmoxClusterOverview } from '@/types/proxmox'
import { useSettings, type ProxmoxUpdateInterval } from '@/hooks/useSettings'

function IntervalToggle({
  interval,
  onIntervalChange
}: {
  interval: ProxmoxUpdateInterval
  onIntervalChange: (interval: ProxmoxUpdateInterval) => void
}) {
  const isFast = interval === 1000

  return (
    <Sheet variant="soft" className="flex items-center gap-1 rounded-lg p-1">
      <Tooltip
        title={
          <div className="flex flex-col gap-1">
            <Typography level="body-sm" className="!text-white">Fast updates (1 second)</Typography>
            <Chip size="sm" color="warning" variant="soft">
              Increases API load on Proxmox
            </Chip>
          </div>
        }
        placement="bottom"
      >
        <IconButton
          size="sm"
          variant={isFast ? 'solid' : 'plain'}
          color={isFast ? 'primary' : 'neutral'}
          onClick={() => onIntervalChange(1000)}
          className="transition-all"
        >
          <Zap size={16} />
        </IconButton>
      </Tooltip>
      <Tooltip
        title={
          <div className="flex flex-col gap-1">
            <Typography level="body-sm" className="!text-white">Relaxed updates (10 seconds)</Typography>
            <Chip size="sm" color="success" variant="soft">
              Recommended for most users
            </Chip>
          </div>
        }
        placement="bottom"
      >
        <IconButton
          size="sm"
          variant={!isFast ? 'solid' : 'plain'}
          color={!isFast ? 'primary' : 'neutral'}
          onClick={() => onIntervalChange(10000)}
          className="transition-all"
        >
          <Waves size={16} />
        </IconButton>
      </Tooltip>
    </Sheet>
  )
}

function UpdateIndicator({
  lastUpdate,
  expectedInterval
}: {
  lastUpdate: number
  expectedInterval: number
}) {
  const [isPulsing, setIsPulsing] = useState(false)
  const [isLate, setIsLate] = useState(false)

  useEffect(() => {
    if (lastUpdate === 0) return

    // Trigger pulse animation on new data
    setIsPulsing(true)
    const pulseTimer = setTimeout(() => setIsPulsing(false), 1000)

    // Check if updates become late (2x the expected interval + 5s buffer)
    const lateThreshold = expectedInterval * 2 + 5000
    const lateCheckTimer = setTimeout(() => {
      setIsLate(true)
    }, lateThreshold)

    // Reset late status when new data arrives
    setIsLate(false)

    return () => {
      clearTimeout(pulseTimer)
      clearTimeout(lateCheckTimer)
    }
  }, [lastUpdate, expectedInterval])

  const lastUpdatedDate = lastUpdate > 0 ? new Date(lastUpdate) : null
  const tooltipTitle = lastUpdatedDate
    ? `Last updated: ${lastUpdatedDate.toLocaleTimeString()}`
    : 'No data yet'

  return (
    <Tooltip title={tooltipTitle} placement="bottom">
      <div className="relative inline-flex items-center justify-center w-2 h-2">
        <div
          className={`absolute w-2 h-2 rounded-full transition-all duration-300 ${
            isLate
              ? 'bg-orange-500 opacity-30'
              : 'bg-green-500 opacity-100'
          }`}
        />
        {isPulsing && !isLate && (
          <div className="absolute w-2 h-2 bg-green-500 rounded-full animate-ping opacity-75" />
        )}
      </div>
    </Tooltip>
  )
}

export const Route = createFileRoute('/proxmox')({
  ssr: false,
  component: ProxmoxPage,
})

function ProxmoxPage() {
  return (
    <AppShell>
      <ProxmoxPageContent />
    </AppShell>
  )
}

function ProxmoxPageContent() {
  const [lastUpdate, setLastUpdate] = useState<number>(0)
  const { proxmox, setProxmoxUpdateInterval } = useSettings()

  return (
    <div className="w-full p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <PageHeader title="Proxmox Dashboard" />
          <UpdateIndicator lastUpdate={lastUpdate} expectedInterval={proxmox.updateInterval} />
        </div>
        <IntervalToggle interval={proxmox.updateInterval} onIntervalChange={setProxmoxUpdateInterval} />
      </div>
      <ProxmoxContent onUpdate={setLastUpdate} />
    </div>
  )
}

function ProxmoxContent({
  onUpdate
}: {
  onUpdate: (timestamp: number) => void
}) {
  const [overview, setOverview] = useState<ProxmoxClusterOverview | null>(null)
  const [configured, setConfigured] = useState<boolean | null>(null)

  const handleData = useCallback((data: ProxmoxClusterOverview) => {
    setOverview(data)
    setConfigured(true)
    onUpdate(Date.now())
  }, [onUpdate])

  const { isConnected, error } = useSSE<ProxmoxClusterOverview>({
    url: '/api/proxmox-overview',
    onData: handleData,
  })

  // Check configuration if connected but no data received after a delay
  const configCheckedRef = useRef(false)
  useEffect(() => {
    if (configCheckedRef.current || overview) return
    if (!isConnected) return

    // Wait briefly — the poll service fires immediately on subscribe,
    // so if data hasn't arrived yet, Proxmox likely isn't configured
    const timer = setTimeout(() => {
      if (!overview && !configCheckedRef.current) {
        configCheckedRef.current = true
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
      <ProxmoxHostView overview={overview} />
    </>
  )
}
