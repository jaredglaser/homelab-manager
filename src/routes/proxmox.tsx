import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Typography, CircularProgress, Tooltip, Chip, ToggleButtonGroup, ToggleButton } from '@mui/material'
import { Zap, Waves } from 'lucide-react'
import type { MouseEvent } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import AppShell from '../components/AppShell'
import PageHeader from '@/components/PageHeader'
import ClusterSummaryCards from '@/components/proxmox/ClusterSummaryCards'
import ProxmoxHostView from '@/components/proxmox/ProxmoxHostView'
import { useTimeSeriesStream } from '@/hooks/useTimeSeriesStream'
import { getHistoricalProxmoxStats, testProxmoxConnection } from '@/data/proxmox.functions'
import { buildProxmoxOverview } from '@/lib/utils/proxmox-overview-builder'
import { apiUrl } from '@/lib/utils/api-url'
import type { ProxmoxStatsRow } from '@/types/proxmox'
import { useSettings, type ProxmoxUpdateInterval } from '@/hooks/useSettings'
import { proxmoxLastUpdateAtom } from '@/hooks/settingsAtom'

function IntervalToggle({
  interval,
  onIntervalChange
}: {
  interval: ProxmoxUpdateInterval
  onIntervalChange: (interval: ProxmoxUpdateInterval) => void
}) {
  return (
    <ToggleButtonGroup
      value={String(interval)}
      onChange={(_e: MouseEvent<HTMLElement>, newValue: string | null) => {
        if (newValue !== null) onIntervalChange(Number(newValue) as ProxmoxUpdateInterval)
      }}
      size="small"
      exclusive
    >
      <ToggleButton value="1000">
        <Tooltip
          title={
            <div className="flex flex-col gap-1">
              <Typography variant="body2" className="!text-white">Fast updates (1 second)</Typography>
              <Chip size="small" color="warning" variant="filled" label="Increases API load on Proxmox" />
            </div>
          }
          placement="bottom"
        >
          <Zap size={16} />
        </Tooltip>
      </ToggleButton>
      <ToggleButton value="10000">
        <Tooltip
          title={
            <div className="flex flex-col gap-1">
              <Typography variant="body2" className="!text-white">Relaxed updates (10 seconds)</Typography>
              <Chip size="small" color="success" variant="filled" label="Recommended for most users" />
            </div>
          }
          placement="bottom"
        >
          <Waves size={16} />
        </Tooltip>
      </ToggleButton>
    </ToggleButtonGroup>
  )
}

function UpdateIndicator({ expectedInterval }: { expectedInterval: number }) {
  const lastUpdate = useAtomValue(proxmoxLastUpdateAtom)
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

/**
 * Renders the Proxmox dashboard content including the header, update controls, and main content area.
 *
 * The header shows the page title, an update freshness indicator, and an interval toggle bound to settings.
 *
 * @returns The JSX element containing the Proxmox dashboard content.
 */
function ProxmoxPageContent() {
  const { proxmox, setProxmoxUpdateInterval } = useSettings()

  return (
    <div className="w-full p-6">
      <div className="flex items-center justify-between mb-6">
        <PageHeader title="Proxmox Dashboard" />
        <div className="flex items-center gap-3">
          <UpdateIndicator expectedInterval={proxmox.updateInterval} />
          <IntervalToggle interval={proxmox.updateInterval} onIntervalChange={setProxmoxUpdateInterval} />
        </div>
      </div>
      <ProxmoxContent />
    </div>
  )
}

const WINDOW_SECONDS = 120

/**
 * Render the Proxmox dashboard content, handling live time-series streaming, configuration checks, and overview-driven UI.
 *
 * Uses a time-series SSE stream (with a 120s window and 1s updates), preloads recent history, updates the global
 * last-update timestamp when new rows arrive, and runs a delayed configuration check if connected but no data is received.
 *
 * @returns The JSX content for the Proxmox dashboard: an error message on stream failure, a configuration guidance panel
 *          when Proxmox is not configured, a loading indicator while awaiting data, or the overview UI (summary cards and host view)
 *          when overview data is available.
 */
function ProxmoxContent() {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const setLastUpdate = useSetAtom(proxmoxLastUpdateAtom)

  const preloadFn = useCallback(
    () => getHistoricalProxmoxStats({ data: { seconds: WINDOW_SECONDS } }) as Promise<ProxmoxStatsRow[]>,
    [],
  )

  const stream = useTimeSeriesStream<ProxmoxStatsRow>({
    sseUrl: apiUrl('/api/proxmox-stats'),
    preloadFn,
    getKey: (r) => `${r.entity_type}/${r.entity_id}/${new Date(r.time).getTime()}`,
    getTime: (r) => new Date(r.time).getTime(),
    getEntity: (r) => `${r.entity_type}/${r.entity_id}`,
    windowSeconds: WINDOW_SECONDS,
    updateIntervalMs: 1000,
  })

  // Update the last-update atom when new rows arrive
  const prevLastRowRef = useRef<ProxmoxStatsRow | null>(null)
  useEffect(() => {
    const lastRow = stream.rows[stream.rows.length - 1] ?? null
    if (lastRow && lastRow !== prevLastRowRef.current) {
      prevLastRowRef.current = lastRow
      setLastUpdate(Date.now())
    }
  }, [stream.rows, setLastUpdate])

  const overview = useMemo(
    () => buildProxmoxOverview(stream.latestByEntity),
    [stream.latestByEntity],
  )

  // Mark configured once we get data
  useEffect(() => {
    if (overview) setConfigured(true)
  }, [overview])

  // Check configuration if connected but no data received after a delay
  const configCheckedRef = useRef(false)
  useEffect(() => {
    if (configCheckedRef.current || overview) return
    if (!stream.isConnected) return

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
  }, [stream.isConnected, overview])

  if (stream.error) {
    return (
      <Typography variant="body1" className="text-red-600 py-8">
        Failed to connect to Proxmox SSE stream: {stream.error.message}
      </Typography>
    )
  }

  if (!overview) {
    if (configured === false) {
      return (
        <div className="py-8">
          <Typography variant="body1" className="mb-2">
            Proxmox is not configured.
          </Typography>
          <Typography variant="body2" className="text-neutral-500">
            Set the following environment variables to connect to your Proxmox cluster:
          </Typography>
          <pre className="mt-3 p-4 bg-[var(--mui-palette-background-level1)] rounded-lg text-sm font-mono">
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
        <CircularProgress size={20} />
        <Typography variant="body1">Loading Proxmox cluster data...</Typography>
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
