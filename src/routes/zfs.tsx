import { useCallback } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import AppShell from '../components/AppShell'
import ZFSPoolsTable from '../components/zfs/ZFSPoolsTable'
import ZFSPoolSpeedCharts from '../components/zfs/ZFSPoolSpeedCharts'
import PageHeader from '@/components/PageHeader'
import { useTimeSeriesStream } from '@/hooks/useTimeSeriesStream'
import { getHistoricalZFSStats } from '@/data/zfs.functions'
import type { ZFSStatsRow } from '@/types/zfs'

export const Route = createFileRoute('/zfs')({
  ssr: false,
  component: ZFSPage,
})

function ZFSPage() {
  return (
    <AppShell>
      <ZFSPageContent />
    </AppShell>
  )
}

function ZFSPageContent() {
  const preloadFn = useCallback(
    () => getHistoricalZFSStats({ data: { seconds: 60 } }),
    [],
  )

  const stream = useTimeSeriesStream<ZFSStatsRow>({
    sseUrl: '/api/zfs-stats',
    preloadFn,
    getKey: (row) => `${new Date(row.time).getTime()}_${row.host}_${row.entity}`,
    getTime: (row) => new Date(row.time).getTime(),
    getEntity: (row) => row.host ? `${row.host}/${row.entity}` : row.entity,
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
