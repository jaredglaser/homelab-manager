import { useCallback, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { queryClient } from '@/components/AppShell'
import ContainerTable, { DOCKER_ENTITY_ICONS_QUERY_KEY } from '@/components/docker/ContainerTable'
import ContainerHistoryPanel from '@/components/docker/ContainerHistoryPanel'
import ContainerInfoPanel from '@/components/docker/ContainerInfoPanel'
import PageHeader from '@/components/PageHeader'
import { useTimeSeriesStream } from '@/hooks/useTimeSeriesStream'
import { getDockerEntityIcons, getContainerVersions } from '@/data/docker.functions'
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
  component: DockerPageContent,
})

// Sparklines always show the last 35s (with 10s padding = 45s buffer).
// The stream window must cover both the chart and sparkline requirements.
const SPARKLINE_BUFFER_SECONDS = 45

function DockerPageContent() {
  const { general, docker, developer } = useSettings()
  const [historyTarget, setHistoryTarget] = useState<{ containerId: string; host: string } | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [infoTarget, setInfoTarget] = useState<{
    containerId: string; host: string; image: string; name: string; serviceKeyEntity: string;
  } | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)

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

  const handleOpenInfo = useCallback((containerId: string, host: string, image: string, name: string, serviceKeyEntity: string) => {
    setInfoTarget({ containerId, host, image, name, serviceKeyEntity })
    setInfoOpen(true)
  }, [])

  const handleCloseInfo = useCallback(() => {
    setInfoOpen(false)
  }, [])

  const handleInfoExited = useCallback(() => {
    setInfoTarget(null)
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

  const { data: versions } = useQuery({
    queryKey: ['container-versions'],
    queryFn: () => getContainerVersions(),
    staleTime: 60_000,
  })

  const versionsWithUpdates = useMemo(() => {
    if (!versions) return undefined
    const set = new Set<string>()
    for (const v of versions) {
      if (v.update_available) set.add(v.image)
    }
    return set
  }, [versions])

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
    <div className="w-full p-6">
      <PageHeader title="Docker Containers Dashboard" />
      <ContainerTable
        latestByEntity={stream.latestByEntity}
        rows={stream.rows}
        hasData={stream.hasData}
        isConnected={stream.isConnected}
        error={stream.error}
        isStale={stream.isStale}
        onOpenHistory={handleOpenHistory}
        onOpenInfo={handleOpenInfo}
        versionsWithUpdates={versionsWithUpdates}
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
      {infoTarget && (
        <ContainerInfoPanel
          open={infoOpen}
          containerId={infoTarget.containerId}
          host={infoTarget.host}
          image={infoTarget.image}
          containerName={infoTarget.name}
          serviceKeyEntity={infoTarget.serviceKeyEntity}
          onClose={handleCloseInfo}
          onExited={handleInfoExited}
        />
      )}
    </div>
  )
}
