import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ThemeProvider from './ThemeProvider'
import Header from './Header'
import Toasts from './Toasts'
import { useSettingsSync } from '@/hooks/useSettingsSync'
import { useLightPaletteEffect } from '@/hooks/useLightPaletteEffect'

const queryClient = new QueryClient()

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
