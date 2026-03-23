import { useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CircularProgress } from '@mui/material'
import {
  DOCKER_PRELOAD_KEY, ZFS_PRELOAD_KEY, PROXMOX_PRELOAD_KEY,
  PRELOAD_STALE_TIME,
  preloadDockerStats, preloadZFSStats, preloadProxmoxStats,
} from '@/lib/constants/preload-queries'
import ThemeProvider from '@/components/ThemeProvider'
import Header from '@/components/Header'
import Toasts from '@/components/Toasts'
import { useSettingsSync } from '@/hooks/useSettingsSync'
import { useLightPaletteEffect } from '@/hooks/useLightPaletteEffect'
import { useAuth } from '@/hooks/useAuth'

if (import.meta.env.VITE_DEMO_MODE === 'true' && typeof window !== 'undefined') {
  // Use .then() instead of top-level await to avoid circular dependency deadlock.
  // The main chunk imports install-demo, which statically imports back from the main
  // chunk (for mock generators). TLA pauses main mid-evaluation, causing deadlock.
  // This is safe because EventSource connections are created in useEffect (deferred),
  // and MockEventSource._start uses setTimeout(50ms) - both fire after .then() resolves.
  void import('@/lib/mock/install-demo').then(({ installDemo }) => installDemo())
}

export const queryClient = new QueryClient()

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { loading } = useAuth()
  useSettingsSync()
  useLightPaletteEffect()

  // Pre-seed all route data on app load so tab switches are instant
  useEffect(() => {
    void queryClient.ensureQueryData({ queryKey: [...DOCKER_PRELOAD_KEY], queryFn: () => preloadDockerStats(), staleTime: PRELOAD_STALE_TIME })
    void queryClient.ensureQueryData({ queryKey: [...ZFS_PRELOAD_KEY], queryFn: preloadZFSStats, staleTime: PRELOAD_STALE_TIME })
    void queryClient.ensureQueryData({ queryKey: [...PROXMOX_PRELOAD_KEY], queryFn: preloadProxmoxStats, staleTime: PRELOAD_STALE_TIME })
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
      <div className="flex flex-col min-h-screen">
        <Header />
        <QueryClientProvider client={queryClient}>
          <div className="flex-1 flex flex-col">
            {children}
          </div>
        </QueryClientProvider>
        <Toasts />
      </div>
    </ThemeProvider>
  )
}
