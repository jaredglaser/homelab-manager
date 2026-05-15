import { useCallback, useEffect, useState } from 'react'
import { createFileRoute, Outlet, useMatchRoute, useLocation } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { queryClient } from '@/lib/query-client'
import ContainerTable, { DOCKER_ENTITY_ICONS_QUERY_KEY } from '@/components/docker/ContainerTable'
import ContainerModal from '@/components/docker/ContainerModal'
import PageStatusBar from '@/components/PageStatusBar'
import DockerStatusSummary from '@/components/docker/DockerStatusSummary'
import { useTimeSeriesStream } from '@/hooks/useTimeSeriesStream'
import { useDockerInventory } from '@/hooks/useDockerInventory'
import { getDockerEntityIcons, updateContainerIcon } from '@/data/docker/functions'
import { useDockerSettings, useGeneralSettings } from '@/hooks/useSettings'
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
  const { general, developer } = useGeneralSettings()
  const { docker } = useDockerSettings()
  const hash = useLocation({ select: (l) => l.hash })

  useEffect(() => {
    if (!hash?.startsWith('host-')) return
    const hostName = hash.slice(5)
    const el = document.querySelector<HTMLElement>(`[data-host-id="${hostName}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    const raf = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-host-id="${hostName}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    return () => cancelAnimationFrame(raf)
  }, [hash])
  const [historyTarget, setHistoryTarget] = useState<{ containerId: string; host: string } | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  const handleOpenHistory = useCallback((containerId: string, host: string) => {
    setHistoryTarget({ containerId, host })
    setHistoryOpen(true)
  }, [])

  const handleCloseHistory = useCallback(() => {
    setHistoryOpen(false)
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

  const { data: entityIcons } = useQuery({
    queryKey: DOCKER_ENTITY_ICONS_QUERY_KEY,
    queryFn: () => getDockerEntityIcons(),
    staleTime: 60_000,
  })

  const handleIconChange = useCallback(
    async (serviceKeyEntity: string, iconSlug: string) => {
      await updateContainerIcon({ data: { serviceKeyEntity, iconSlug } })
      await qc.invalidateQueries({ queryKey: DOCKER_ENTITY_ICONS_QUERY_KEY })
    },
    [qc],
  )

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

  const { inventory, isConnected: isInventoryConnected, error: inventoryError } = useDockerInventory()

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageStatusBar left={<DockerStatusSummary inventory={inventory} />} />
      <ContainerTable
        inventory={inventory}
        isInventoryConnected={isInventoryConnected}
        inventoryError={inventoryError}
        latestByEntity={stream.latestByEntity}
        rows={stream.rows}
        hasData={stream.hasData}
        isConnected={stream.isConnected}
        error={stream.error}
        isStale={stream.isStale}
        entityIcons={entityIcons ?? {}}
        onIconChange={handleIconChange}
        onOpenHistory={handleOpenHistory}
      />
      {historyTarget && (
        <ContainerModal
          open={historyOpen}
          onClose={handleCloseHistory}
          containerId={historyTarget.containerId}
          host={historyTarget.host}
          inventory={inventory.get(`${historyTarget.host}/${historyTarget.containerId}`) ?? null}
          initialTab="history"
          iconSlug={entityIcons?.[`${historyTarget.host}/${historyTarget.containerId}`]?.iconSlug}
        />
      )}
    </div>
  )
}
