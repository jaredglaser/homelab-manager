import { useEffect } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'

import {
  DOCKER_PRELOAD_KEY, ZFS_PRELOAD_KEY, PROXMOX_PRELOAD_KEY,
  PRELOAD_STALE_TIME,
  preloadDockerStats, preloadZFSStats, preloadProxmoxStats,
} from '@/lib/constants/preload-queries'
import ThemeProvider from '@/components/ThemeProvider'
import Header from '@/components/header'
import Toasts from '@/components/Toasts'
import { useSettingsSync } from '@/hooks/useSettingsSync'
import { useLightPaletteEffect } from '@/hooks/useLightPaletteEffect'
import { queryClient } from '@/lib/query-client'
import { IS_DEMO_MODE } from '@/lib/constants/demo'
import { useAuth } from '@/hooks/useAuth'
import { Spinner } from '@/components/ui/spinner';

if (IS_DEMO_MODE && typeof window !== 'undefined') {
  // Use .then() instead of top-level await to avoid circular dependency deadlock.
  // The main chunk imports install-demo, which statically imports back from the main
  // chunk (for mock generators). TLA pauses main mid-evaluation, causing deadlock.
  // This is safe because EventSource connections are created in useEffect (deferred),
  // and MockEventSource._start uses setTimeout(50ms) - both fire after .then() resolves.
  import('@/lib/mock/install-demo').then(({ installDemo }) => installDemo()).catch((err) => console.error('Failed to install demo mode:', err))
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { loading, user, authEnabled } = useAuth()
  useSettingsSync()
  useLightPaletteEffect()

  // Pre-seed route data after auth resolves so tab switches are instant.
  // Gated on loading: avoids firing before the session check completes, which
  // causes 401s when auth is enabled. When auth is disabled, server functions
  // accept the synthetic admin so preloads work even with user=null.
  useEffect(() => {
    if (loading) return;
    // With auth enabled, only preload once the session is confirmed. If there's
    // no session, a redirect to /login is already in flight.
    if (authEnabled && !user) return;
    queryClient.ensureQueryData({ queryKey: [...DOCKER_PRELOAD_KEY], queryFn: () => preloadDockerStats(), staleTime: PRELOAD_STALE_TIME }).catch((err) => console.error('Failed to preload Docker stats:', err))
    queryClient.ensureQueryData({ queryKey: [...ZFS_PRELOAD_KEY], queryFn: preloadZFSStats, staleTime: PRELOAD_STALE_TIME }).catch((err) => console.error('Failed to preload ZFS stats:', err))
    queryClient.ensureQueryData({ queryKey: [...PROXMOX_PRELOAD_KEY], queryFn: preloadProxmoxStats, staleTime: PRELOAD_STALE_TIME }).catch((err) => console.error('Failed to preload Proxmox stats:', err))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading])

  if (loading) {
    return (
      <ThemeProvider>
        <div className="flex items-center justify-center min-h-screen">
          <Spinner />
        </div>
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <div className="flex flex-col h-screen overflow-hidden">
          <Header user={user} />
          <div className="flex-1 flex flex-col min-h-0 [view-transition-name:page-content]">
            {children}
          </div>
          <Toasts />
        </div>
      </QueryClientProvider>
    </ThemeProvider>
  )
}
