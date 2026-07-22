import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useSetAtom } from 'jotai'
import PageStatusBar from '@/components/PageStatusBar'
import ProxmoxStatusSummary from '@/components/proxmox/ProxmoxStatusSummary'
import ClusterSummaryCards from '@/components/proxmox/ClusterSummaryCards'
import ProxmoxHostView from '@/components/proxmox/ProxmoxHostView'
import { IntervalToggle } from '@/components/proxmox/ProxmoxIntervalToggle'
import { UpdateIndicator } from '@/components/proxmox/ProxmoxUpdateIndicator'
import { useTimeSeriesStream } from '@/hooks/useTimeSeriesStream'
import { testProxmoxConnection } from '@/data/proxmox/functions'
import { PROXMOX_PRELOAD_KEY, PRELOAD_STALE_TIME, preloadProxmoxStats } from '@/lib/constants/preload-queries'
import { buildProxmoxOverview } from '@/lib/utils/proxmox-overview-builder'
import { proxmoxStatsChannel } from '@/lib/sse/channels/proxmox-stats'
import type { ProxmoxStatsRowRevived, ProxmoxClusterOverview } from '@/types/proxmox'
import { useProxmoxSettings } from '@/hooks/useSettings'
import { proxmoxLastUpdateAtom } from '@/hooks/settingsAtom'
import { Spinner } from '@/components/ui/spinner';

export const Route = createFileRoute('/proxmox')({
  ssr: false,
  component: ProxmoxPageContent,
})

/**
 * Renders the Proxmox dashboard content including the status bar, update controls, and main content area.
 *
 * The status bar shows node/VM/LXC counts in the left slot and the update freshness indicator plus
 * interval toggle in the right slot.
 *
 * @returns The JSX element containing the Proxmox dashboard content.
 */
function ProxmoxPageContent() {
  const { proxmox, setProxmoxUpdateInterval } = useProxmoxSettings()
  const [overview, setOverview] = useState<ProxmoxClusterOverview | null>(null)

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageStatusBar
        left={<ProxmoxStatusSummary overview={overview} />}
        right={
          <>
            <UpdateIndicator expectedInterval={proxmox.updateInterval} />
            <IntervalToggle interval={proxmox.updateInterval} onIntervalChange={setProxmoxUpdateInterval} />
          </>
        }
      />
      <ProxmoxContent onOverviewChange={setOverview} />
    </div>
  )
}

const WINDOW_SECONDS = 120

interface ProxmoxContentProps {
  onOverviewChange: (overview: ProxmoxClusterOverview | null) => void;
}

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
function ProxmoxContent({ onOverviewChange }: Readonly<ProxmoxContentProps>) {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const setLastUpdate = useSetAtom(proxmoxLastUpdateAtom)

  const preloadFn = useCallback(preloadProxmoxStats, [])

  const { data: initialData } = useQuery({
    queryKey: PROXMOX_PRELOAD_KEY,
    queryFn: preloadProxmoxStats,
    staleTime: PRELOAD_STALE_TIME,
  })

  const stream = useTimeSeriesStream({
    channel: proxmoxStatsChannel,
    preloadFn,
    getKey: (r) => `${r.entity_type}/${r.entity_id}/${r.time}`,
    getTime: (r) => r.time,
    getEntity: (r) => `${r.entity_type}/${r.entity_id}`,
    windowSeconds: WINDOW_SECONDS,
    updateIntervalMs: 1000,
    initialData,
  })

  // Update the last-update atom when new rows arrive
  const prevLastRowRef = useRef<ProxmoxStatsRowRevived | null>(null)
  useEffect(() => {
    const lastRow = stream.rows.at(-1) ?? null
    if (lastRow && lastRow !== prevLastRowRef.current) {
      prevLastRowRef.current = lastRow
      setLastUpdate(Date.now())
    }
  }, [stream.rows, setLastUpdate])

  const overview = useMemo(
    () => buildProxmoxOverview(stream.latestByEntity),
    [stream.latestByEntity],
  )

  // Bubble overview up to parent so the status bar can display counts
  useEffect(() => {
    onOverviewChange(overview)
  }, [overview, onOverviewChange])

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
      <p className="text-base text-destructive py-8">
        Failed to connect to Proxmox SSE stream: {stream.error.message}
      </p>
    )
  }

  if (!overview) {
    if (configured === false) {
      return (
        <div className="py-8">
          <p className="text-base mb-2">
            Proxmox is not configured.
          </p>
          <p className="text-sm text-(--muted-foreground)">
            Set the following environment variables to connect to your Proxmox cluster:
          </p>
          <pre className="mt-3 p-4 bg-(--level1) rounded-lg text-sm font-mono">
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
        <Spinner className="size-5" />
        <p className="text-base">Loading Proxmox cluster data...</p>
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
