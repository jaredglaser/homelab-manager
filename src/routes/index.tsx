import { useCallback } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import AppShell from '../components/AppShell'
import ContainerTable from '../components/docker/ContainerTable'
import PageHeader from '@/components/PageHeader'
import { useTimeSeriesStream } from '@/hooks/useTimeSeriesStream'
import { getHistoricalDockerStats } from '@/data/docker.functions'
import type { DockerStatsRow } from '@/types/docker'

export const Route = createFileRoute('/')({ ssr: false, component: DockerPage })

function DockerPage() {
  const preloadFn = useCallback(
    () => getHistoricalDockerStats({ data: { seconds: 60 } }),
    [],
  )

  const stream = useTimeSeriesStream<DockerStatsRow>({
    sseUrl: '/api/docker-stats',
    preloadFn,
    getKey: (row) => `${new Date(row.time).getTime()}_${row.host}_${row.container_id}`,
    getTime: (row) => new Date(row.time).getTime(),
    getEntity: (row) => `${row.host}/${row.container_id}`,
  })

  return (
    <AppShell>
      <div className="w-full p-6">
        <PageHeader title="Docker Containers Dashboard" />
        <ContainerTable
          latestByEntity={stream.latestByEntity}
          rows={stream.rows}
          hasData={stream.hasData}
          isConnected={stream.isConnected}
          error={stream.error}
          isStale={stream.isStale}
        />
      </div>
    </AppShell>
  )
}
