import { useCallback } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import ZFSPoolsTable from '@/components/zfs/ZFSPoolsTable'
import ZFSPoolSpeedCharts from '@/components/zfs/ZFSPoolSpeedCharts'
import PageStatusBar from '@/components/PageStatusBar'
import ZFSStatusSummary from '@/components/zfs/ZFSStatusSummary'
import { useTimeSeriesStream } from '@/hooks/useTimeSeriesStream'
import { useGeneralSettings } from '@/hooks/useSettings'
import { ZFS_PRELOAD_KEY, PRELOAD_STALE_TIME, preloadZFSStats } from '@/lib/constants/preload-queries'
import { zfsStatsChannel } from '@/lib/sse/channels/zfs-stats'
import { queryClient } from '@/lib/query-client'
import { viewStateQueryOptions } from '@/hooks/useViewState'

export const Route = createFileRoute('/zfs')({
  ssr: false,
  loader: () => queryClient.ensureQueryData(viewStateQueryOptions),
  component: ZFSPageContent,
})

function ZFSPageContent() {
  const { general } = useGeneralSettings()

  const preloadFn = useCallback(preloadZFSStats, [])

  const { data: initialData } = useQuery({
    queryKey: ZFS_PRELOAD_KEY,
    queryFn: preloadZFSStats,
    staleTime: PRELOAD_STALE_TIME,
  })

  const stream = useTimeSeriesStream({
    channel: zfsStatsChannel,
    preloadFn,
    getKey: (row) => `${row.time}_${row.host}_${row.entity}`,
    getTime: (row) => row.time,
    getEntity: (row) => row.host ? `${row.host}/${row.entity}` : row.entity,
    windowSeconds: 90,
    updateIntervalMs: general.updateIntervalMs,
    initialData,
  })

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageStatusBar left={<ZFSStatusSummary latestByEntity={stream.latestByEntity} />} />
      <ZFSPoolsTable
        latestByEntity={stream.latestByEntity}
        hasData={stream.hasData}
        isConnected={stream.isConnected}
        error={stream.error}
        isStale={stream.isStale}
      />
      <ZFSPoolSpeedCharts rows={stream.rows} />
    </div>
  )
}
