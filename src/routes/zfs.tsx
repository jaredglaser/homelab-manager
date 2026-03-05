import { useCallback } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import ZFSPoolsTable from '../components/zfs/ZFSPoolsTable'
import ZFSPoolSpeedCharts from '../components/zfs/ZFSPoolSpeedCharts'
import PageHeader from '@/components/PageHeader'
import { useTimeSeriesStream } from '@/hooks/useTimeSeriesStream'
import { getHistoricalZFSStats } from '@/data/zfs.functions'
import { useSettings } from '@/hooks/useSettings'
import { apiUrl } from '@/lib/utils/api-url'
import type { ZFSStatsRow } from '@/types/zfs'

export const Route = createFileRoute('/zfs')({
  ssr: false,
  component: ZFSPageContent,
})

function ZFSPageContent() {
  const { general } = useSettings()

  const preloadFn = useCallback(
    () => getHistoricalZFSStats({ data: { seconds: 90 } }),
    [],
  )

  const stream = useTimeSeriesStream<ZFSStatsRow>({
    sseUrl: apiUrl('/api/zfs-stats'),
    preloadFn,
    getKey: (row) => `${new Date(row.time).getTime()}_${row.host}_${row.entity}`,
    getTime: (row) => new Date(row.time).getTime(),
    getEntity: (row) => row.host ? `${row.host}/${row.entity}` : row.entity,
    windowSeconds: 90,
    updateIntervalMs: general.updateIntervalMs,
  })

  return (
    <div className="w-full p-6">
      <PageHeader title="ZFS Pools Dashboard" />
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
