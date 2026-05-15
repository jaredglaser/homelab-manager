import { useEffect } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { CircularProgress } from '@mui/material'
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

if (IS_DEMO_MODE && typeof window !== 'undefined') {
  // Use .then() instead of top-level await to avoid circular dependency deadlock.
  // The main chunk imports install-demo, which statically imports back from the main
  // chunk (for mock generators). TLA pauses main mid-evaluation, causing deadlock.
  // This is safe because EventSource connections are created in useEffect (deferred),
  // and MockEventSource._start uses setTimeout(50ms) - both fire after .then() resolves.
  import('@/lib/mock/install-demo').then(({ installDemo }) => installDemo()).catch((err) => console.error('Failed to install demo mode:', err))
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { loading, user } = useAuth()
  useSettingsSync()
  useLightPaletteEffect()

  // Pre-seed all route data on app load so tab switches are instant
  useEffect(() => {
    queryClient.ensureQueryData({ queryKey: [...DOCKER_PRELOAD_KEY], queryFn: () => preloadDockerStats(), staleTime: PRELOAD_STALE_TIME }).catch((err) => console.error('Failed to preload Docker stats:', err))
    queryClient.ensureQueryData({ queryKey: [...ZFS_PRELOAD_KEY], queryFn: preloadZFSStats, staleTime: PRELOAD_STALE_TIME }).catch((err) => console.error('Failed to preload ZFS stats:', err))
    queryClient.ensureQueryData({ queryKey: [...PROXMOX_PRELOAD_KEY], queryFn: preloadProxmoxStats, staleTime: PRELOAD_STALE_TIME }).catch((err) => console.error('Failed to preload Proxmox stats:', err))
  }, [])

  if (loading) {
    return (
      <ThemeProvider>
        <div className="flex items-center justify-center min-h-screen">
          <CircularProgress />
        </div>
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <div className="flex flex-col h-screen overflow-hidden">
          <Header user={user?.id === 0 ? null : user} />
          <div className="flex-1 flex flex-col min-h-0 [view-transition-name:page-content]">
            {children}
          </div>
          <Toasts />
        </div>
      </QueryClientProvider>
    </ThemeProvider>
  )
}
