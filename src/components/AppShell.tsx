import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ThemeProvider from './ThemeProvider'
import Header from './Header'
import Toasts from './Toasts'
import { useSettingsSync } from '@/hooks/useSettingsSync'
import { useLightPaletteEffect } from '@/hooks/useLightPaletteEffect'

if (import.meta.env.VITE_DEMO_MODE === 'true' && typeof window !== 'undefined') {
  const { installDemo } = await import('@/lib/mock/install-demo')
  installDemo()
}

const DEMO_BANNER_KEY = 'demo-banner-dismissed'

function DemoBanner() {
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(DEMO_BANNER_KEY) === 'true' } catch { return false }
  })

  if (dismissed) return null

  function dismiss() {
    try { sessionStorage.setItem(DEMO_BANNER_KEY, 'true') } catch { /* storage unavailable */ }
    setDismissed(true)
  }

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2 bg-[var(--mui-palette-info-main)] text-[var(--mui-palette-info-contrastText)] text-sm">
      <span>
        <strong>Demo mode</strong> — all data is generated in the browser with no server or database.
        {' '}
        <a
          href="https://github.com/jaredglaser/homelab-manager"
          target="_blank"
          rel="noopener noreferrer"
          className="underline font-medium"
        >
          View on GitHub
        </a>
        {' '}or see the{' '}
        <a
          href="https://github.com/jaredglaser/homelab-manager/blob/main/self-hosting/README.md"
          target="_blank"
          rel="noopener noreferrer"
          className="underline font-medium"
        >
          self-hosting guide
        </a>
        {' '}to run it against your own infrastructure.
      </span>
      <button type="button" onClick={dismiss} aria-label="Dismiss demo banner" className="shrink-0 opacity-80 hover:opacity-100 cursor-pointer text-lg leading-none">
        ✕
      </button>
    </div>
  )
}

export const queryClient = new QueryClient()

export default function AppShell({ children }: { children: React.ReactNode }) {
  useSettingsSync()
  useLightPaletteEffect()

  return (
    <ThemeProvider>
      <Header />
      {import.meta.env.VITE_DEMO_MODE === 'true' && <DemoBanner />}
      <QueryClientProvider client={queryClient}>
        <div className="min-h-screen">
          {children}
        </div>
      </QueryClientProvider>
      <Toasts />
    </ThemeProvider>
  )
}
