import { useState, useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Alert from '@mui/material/Alert'
import Link from '@mui/material/Link'
import ThemeProvider from './ThemeProvider'
import Header from './Header'
import Toasts from './Toasts'
import { useSettingsSync } from '@/hooks/useSettingsSync'
import { useLightPaletteEffect } from '@/hooks/useLightPaletteEffect'

if (import.meta.env.VITE_DEMO_MODE === 'true' && typeof window !== 'undefined') {
  // Use .then() instead of top-level await to avoid circular dependency deadlock.
  // The main chunk imports install-demo, which statically imports back from the main
  // chunk (for mock generators). TLA pauses main mid-evaluation, causing deadlock.
  // This is safe because EventSource connections are created in useEffect (deferred),
  // and MockEventSource._start uses setTimeout(50ms) - both fire after .then() resolves.
  void import('@/lib/mock/install-demo').then(({ installDemo }) => installDemo())
}

const DEMO_BANNER_KEY = 'demo-banner-dismissed'

function DemoBanner() {
  // Start hidden to avoid hydration mismatch (sessionStorage unavailable on server)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    try {
      if (sessionStorage.getItem(DEMO_BANNER_KEY) !== 'true') setVisible(true)
    } catch { /* storage unavailable */ }
  }, [])

  if (!visible) return null

  function dismiss() {
    try { sessionStorage.setItem(DEMO_BANNER_KEY, 'true') } catch { /* storage unavailable */ }
    setVisible(false)
  }

  return (
    <div className="px-4 pb-1">
      <div className="mx-auto max-w-5xl">
        <Alert severity="info" onClose={dismiss}>
          <strong>Demo mode</strong> &mdash; all data is generated in the browser.
          {' '}
          <Link href="https://github.com/jaredglaser/homelab-manager" target="_blank" rel="noopener noreferrer">
            GitHub
          </Link>
          {' '}&middot;{' '}
          <Link href="https://github.com/jaredglaser/homelab-manager/blob/main/self-hosting/README.md" target="_blank" rel="noopener noreferrer">
            Self-host guide
          </Link>
        </Alert>
      </div>
    </div>
  )
}

export const queryClient = new QueryClient()

export default function AppShell({ children }: { children: React.ReactNode }) {
  useSettingsSync()
  useLightPaletteEffect()

  return (
    <ThemeProvider>
      <div className="flex flex-col min-h-screen">
        <Header />
        {import.meta.env.VITE_DEMO_MODE === 'true' && <DemoBanner />}
        <QueryClientProvider client={queryClient}>
          <div className="flex-1 flex flex-col [view-transition-name:page-content]">
            {children}
          </div>
        </QueryClientProvider>
        <Toasts />
      </div>
    </ThemeProvider>
  )
}
