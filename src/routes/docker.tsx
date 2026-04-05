import { useCallback, useState } from 'react'
import { createFileRoute, Outlet, useMatchRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { queryClient } from '@/components/AppShell'
import ContainerTable, { DOCKER_ENTITY_ICONS_QUERY_KEY } from '@/components/docker/ContainerTable'
import ContainerHistoryPanel from '@/components/docker/ContainerHistoryPanel'
import PageHeader from '@/components/PageHeader'
import { useTimeSeriesStream } from '@/hooks/useTimeSeriesStream'
import { getDockerEntityIcons } from '@/data/docker/functions'
import { useSettings } from '@/hooks/useSettings'
import { apiUrl } from '@/lib/utils/api-url'
import { DOCKER_PRELOAD_KEY, PRELOAD_STALE_TIME, preloadDockerStats } from '@/lib/constants/preload-queries'
import type { DockerStatsRow } from '@/types/docker'


export const Route = createFileRoute('/docker')({
  ssr: false,
  loader: () => queryClient.ensureQueryData({
    queryKey: DOCKER_ENTITY_ICONS_QUERY_KEY,
    queryFn: () => getDockerEntityIcons(),
    staleTime: 60_000,
  }),
  component: DockerLayout,
})

function DockerLayout() {
  const matchRoute = useMatchRoute()
  const isExactDockerRoute = matchRoute({ to: '/docker' })

  if (!isExactDockerRoute) return <Outlet />
  return <DockerContainersPage />
}

// Sparklines always show the last 35s (with 10s padding = 45s buffer).
// The stream window must cover both the chart and sparkline requirements.
const SPARKLINE_BUFFER_SECONDS = 45

function DockerContainersPage() {
  const { general, docker, developer } = useSettings()
  const [historyTarget, setHistoryTarget] = useState<{ containerId: string; host: string } | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  const handleOpenHistory = useCallback((containerId: string, host: string) => {
    setHistoryTarget({ containerId, host })
    setHistoryOpen(true)
  }, [])

  const handleCloseHistory = useCallback(() => {
    setHistoryOpen(false)
  }, [])

  const handleHistoryExited = useCallback(() => {
    setHistoryTarget(null)
  }, [])

  const windowSeconds = Math.max(docker.chartWindowSeconds + 10, SPARKLINE_BUFFER_SECONDS)
  const qc = useQueryClient()

  const dockerQueryKey = [...DOCKER_PRELOAD_KEY, windowSeconds] as const

  const preloadFn = useCallback(
    () => qc.fetchQuery({
      queryKey: dockerQueryKey,
      queryFn: () => preloadDockerStats(windowSeconds),
      staleTime: 0,
    }),
    [qc, windowSeconds],
  )

  const { data: initialData } = useQuery({
    queryKey: dockerQueryKey,
    queryFn: () => preloadDockerStats(windowSeconds),
    staleTime: PRELOAD_STALE_TIME,
  })

  const stream = useTimeSeriesStream<DockerStatsRow>({
    sseUrl: apiUrl('/api/docker-stats'),
    preloadFn,
    getKey: (row) => `${new Date(row.time).getTime()}_${row.host}_${row.container_id}`,
    getTime: (row) => new Date(row.time).getTime(),
    getEntity: (row) => `${row.host}/${row.container_id}`,
    windowSeconds,
    updateIntervalMs: general.updateIntervalMs,
    refreshIntervalMs: 60_000,
    initialData,
    debug: developer.sseDebugLogging,
  })

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader title="Docker Containers Dashboard" />
      <ContainerTable
        latestByEntity={stream.latestByEntity}
        rows={stream.rows}
        hasData={stream.hasData}
        isConnected={stream.isConnected}
        error={stream.error}
        isStale={stream.isStale}
        onOpenHistory={handleOpenHistory}
      />
      {historyTarget && (
        <ContainerHistoryPanel
          open={historyOpen}
          containerId={historyTarget.containerId}
          host={historyTarget.host}
          onClose={handleCloseHistory}
          onExited={handleHistoryExited}
        />
      )}
    </div>
  )
}
