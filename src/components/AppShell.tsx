import { useEffect } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'

import {
  ZFS_PRELOAD_KEY, PROXMOX_PRELOAD_KEY,
  PRELOAD_STALE_TIME,
  dockerPreloadQueryKey, dockerStatsWindowSeconds,
  preloadDockerStats, preloadZFSStats, preloadProxmoxStats,
} from '@/lib/constants/preload-queries'
import Header from '@/components/header'
import Toasts from '@/components/Toasts'
import { useSettingsSync } from '@/hooks/useSettingsSync'
import { useDockerSettings } from '@/hooks/useSettings'
import { useLightPaletteEffect } from '@/hooks/useLightPaletteEffect'
import { queryClient } from '@/lib/query-client'
import { useAuth } from '@/hooks/useAuth'
import { Spinner } from '@/components/ui/spinner';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { loading, user, authEnabled } = useAuth()
  useSettingsSync()
  useLightPaletteEffect()
  const { docker } = useDockerSettings()
  // The route keys its preload by window size, so the warm-up must derive the
  // same window or it seeds a cache entry the route never reads.
  const dockerWindowSeconds = dockerStatsWindowSeconds(docker.chartWindowSeconds)

  // Pre-seed route data after auth resolves so tab switches are instant.
  // Gated on loading: avoids firing before the session check completes, which
  // causes 401s when auth is enabled. When auth is disabled, server functions
  // accept the synthetic admin so preloads work even with user=null.
  // dockerWindowSeconds is a dep so a late settings sync re-warms the correct key.
  useEffect(() => {
    if (loading) return;
    // With auth enabled, only preload once the session is confirmed. If there's
    // no session, a redirect to /login is already in flight.
    if (authEnabled && !user) return;
    queryClient.ensureQueryData({ queryKey: dockerPreloadQueryKey(dockerWindowSeconds), queryFn: () => preloadDockerStats(dockerWindowSeconds), staleTime: PRELOAD_STALE_TIME }).catch((err) => console.error('Failed to preload Docker stats:', err))
    queryClient.ensureQueryData({ queryKey: [...ZFS_PRELOAD_KEY], queryFn: preloadZFSStats, staleTime: PRELOAD_STALE_TIME }).catch((err) => console.error('Failed to preload ZFS stats:', err))
    queryClient.ensureQueryData({ queryKey: [...PROXMOX_PRELOAD_KEY], queryFn: preloadProxmoxStats, staleTime: PRELOAD_STALE_TIME }).catch((err) => console.error('Failed to preload Proxmox stats:', err))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, dockerWindowSeconds])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner />
      </div>
    )
  }

  return (
    <QueryClientProvider client={queryClient}>
      <div className="flex flex-col h-screen overflow-hidden">
        <Header user={user} />
        <div className="flex-1 flex flex-col min-h-0 [view-transition-name:page-content]">
          {children}
        </div>
        <Toasts />
      </div>
    </QueryClientProvider>
  )
}
