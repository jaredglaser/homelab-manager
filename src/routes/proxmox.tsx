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
import {
  PROXMOX_LIVE_CONNECTION_LOST,
  ProxmoxNoticeList,
  proxmoxDataExpected,
  proxmoxStateNotices,
} from '@/components/proxmox/ProxmoxNotices'
import { useTimeSeriesStream } from '@/hooks/useTimeSeriesStream'
import { PROXMOX_PRELOAD_KEY, PRELOAD_STALE_TIME, preloadProxmoxStats } from '@/lib/constants/preload-queries'
import { buildProxmoxOverview, proxmoxEntityKey } from '@/lib/utils/proxmox-overview-builder'
import { proxmoxStatsChannel } from '@/lib/channels/proxmox-stats'
import { proxmoxStateChannel, type ProxmoxStateMessage } from '@/lib/channels/proxmox-state'
import { useMuxQuery } from '@/lib/mux/use-mux-channel'
import type { ProxmoxStatsRow, ProxmoxClusterOverview } from '@/types/proxmox'
import { useGeneralSettings, useProxmoxSettings } from '@/hooks/useSettings'
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

const PROXMOX_STATE_QUERY_KEY = ['proxmox-state']

const keepLatestState = (_prev: ProxmoxStateMessage | null, next: ProxmoxStateMessage) => next

/**
 * Live Proxmox content. The worker's recorded state decides the notices (not set up, collector off,
 * unreachable, token rejected, certificate refused) and the last data stays on screen under them.
 */
function ProxmoxContent({ onOverviewChange }: Readonly<ProxmoxContentProps>) {
  const setLastUpdate = useSetAtom(proxmoxLastUpdateAtom)
  const { general: { use12HourTime } } = useGeneralSettings()

  const preloadFn = useCallback(preloadProxmoxStats, [])

  const { data: initialData } = useQuery({
    queryKey: PROXMOX_PRELOAD_KEY,
    queryFn: preloadProxmoxStats,
    staleTime: PRELOAD_STALE_TIME,
  })

  const stream = useTimeSeriesStream({
    channel: proxmoxStatsChannel,
    preloadFn,
    getKey: (r) => `${proxmoxEntityKey(r)}/${r.time}`,
    getTime: (r) => r.time,
    getEntity: proxmoxEntityKey,
    windowSeconds: WINDOW_SECONDS,
    updateIntervalMs: 1000,
    initialData,
  })

  const { state: collectorState } = useMuxQuery(proxmoxStateChannel, {
    queryKey: PROXMOX_STATE_QUERY_KEY,
    initial: null as ProxmoxStateMessage | null,
    fold: keepLatestState,
  })

  // Update the last-update atom when new rows arrive
  const prevLastRowRef = useRef<ProxmoxStatsRow | null>(null)
  useEffect(() => {
    const lastRow = stream.rows.at(-1) ?? null
    if (lastRow && lastRow !== prevLastRowRef.current) {
      prevLastRowRef.current = lastRow
      setLastUpdate(Date.now())
    }
  }, [stream.rows, setLastUpdate])

  useEffect(() => {
    if (stream.error) console.error('[proxmox] Live stream error:', stream.error.message)
  }, [stream.error])

  const overview = useMemo(
    () => buildProxmoxOverview(stream.latestByEntity),
    [stream.latestByEntity],
  )

  // Bubble overview up to parent so the status bar can display counts
  useEffect(() => {
    onOverviewChange(overview)
  }, [overview, onOverviewChange])

  const notices = useMemo(() => {
    const fromState = proxmoxStateNotices(collectorState, use12HourTime, overview !== null)
    return stream.error ? [{ key: 'live-connection', text: PROXMOX_LIVE_CONNECTION_LOST }, ...fromState] : fromState
  }, [collectorState, use12HourTime, overview, stream.error])

  return (
    <>
      <ProxmoxNoticeList notices={notices} />
      {overview && (
        <>
          <ClusterSummaryCards overview={overview} />
          <ProxmoxHostView overview={overview} />
        </>
      )}
      {!overview && !stream.error && proxmoxDataExpected(collectorState) && (
        <div className="flex items-center gap-3 py-12">
          <Spinner className="size-5" />
          <p className="text-base">Loading Proxmox cluster data...</p>
        </div>
      )}
    </>
  )
}
