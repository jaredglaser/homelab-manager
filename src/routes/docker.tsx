import { useCallback, useEffect } from 'react'
import { createFileRoute, Outlet, useMatchRoute, useLocation } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { queryClient } from '@/lib/query-client'
import ContainerTable, { DOCKER_ENTITY_ICONS_QUERY_KEY } from '@/components/docker/ContainerTable'
import PageStatusBar from '@/components/PageStatusBar'
import DockerStatusSummary from '@/components/docker/DockerStatusSummary'
import { useTimeSeriesStream } from '@/hooks/useTimeSeriesStream'
import { useDockerInventory } from '@/hooks/useDockerInventory'
import { getDockerEntityIcons, updateContainerIcon, clearContainerIcon } from '@/data/docker/functions'
import { useDockerSettings, useGeneralSettings } from '@/hooks/useSettings'
import { apiUrl } from '@/lib/utils/api-url'
import { PRELOAD_STALE_TIME, dockerPreloadQueryKey, dockerStatsWindowSeconds, preloadDockerStats } from '@/lib/constants/preload-queries'
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
  const windowSeconds = dockerStatsWindowSeconds(docker.chartWindowSeconds)
  const qc = useQueryClient()

  const dockerQueryKey = dockerPreloadQueryKey(windowSeconds)

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
    async (serviceKeyEntity: string, iconSlug: string | null) => {
      if (iconSlug === null) {
        await clearContainerIcon({ data: { serviceKeyEntity } });
      } else {
        await updateContainerIcon({ data: { serviceKeyEntity, iconSlug } });
      }
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
      />
    </div>
  )
}
