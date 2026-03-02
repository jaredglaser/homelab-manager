import { useCallback } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import AppShell, { queryClient } from '@/components/AppShell'
import ContainerTable, { DOCKER_ENTITY_ICONS_QUERY_KEY } from '@/components/docker/ContainerTable'
import PageHeader from '@/components/PageHeader'
import { useTimeSeriesStream } from '@/hooks/useTimeSeriesStream'
import { getHistoricalDockerStats, getDockerEntityIcons } from '@/data/docker.functions'
import { useSettings } from '@/hooks/useSettings'
import type { DockerStatsRow } from '@/types/docker'


export const Route = createFileRoute('/')({
  ssr: false,
  loader: () => queryClient.ensureQueryData({
    queryKey: DOCKER_ENTITY_ICONS_QUERY_KEY,
    queryFn: () => getDockerEntityIcons(),
    staleTime: 60_000,
  }),
  component: DockerPage,
})

function DockerPage() {
  return (
    <AppShell>
      <DockerPageContent />
    </AppShell>
  )
}

/**
 * Render the Docker Containers dashboard content and wire it to a live time-series stream of Docker stats.
 *
 * @returns The React element containing the page header and a container table populated with the latest and historical Docker metrics.
 */
// Sparklines always show the last 35s (with 10s padding = 45s buffer).
// The stream window must cover both the chart and sparkline requirements.
const SPARKLINE_BUFFER_SECONDS = 45

function DockerPageContent() {
  const { general, docker, developer } = useSettings()

  const windowSeconds = Math.max(docker.chartWindowSeconds + 10, SPARKLINE_BUFFER_SECONDS)

  const preloadFn = useCallback(
    () => getHistoricalDockerStats({ data: { seconds: windowSeconds } }),
    [windowSeconds],
  )

  const stream = useTimeSeriesStream<DockerStatsRow>({
    sseUrl: '/api/docker-stats',
    preloadFn,
    getKey: (row) => `${new Date(row.time).getTime()}_${row.host}_${row.container_id}`,
    getTime: (row) => new Date(row.time).getTime(),
    getEntity: (row) => `${row.host}/${row.container_id}`,
    windowSeconds,
    updateIntervalMs: general.updateIntervalMs,
    refreshIntervalMs: 60_000,
    debug: developer.sseDebugLogging,
  })

  return (
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
  )
}
