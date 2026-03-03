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

export const queryClient = new QueryClient()

export default function AppShell({ children }: { children: React.ReactNode }) {
  useSettingsSync()
  useLightPaletteEffect()

  return (
    <ThemeProvider>
      <Header />
      <QueryClientProvider client={queryClient}>
        <div className="min-h-screen">
          {children}
        </div>
      </QueryClientProvider>
      <Toasts />
    </ThemeProvider>
  )
}
