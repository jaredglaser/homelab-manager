import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ThemeProvider from './ThemeProvider'
import Header from './Header'
import { SettingsProvider } from '@/hooks/useSettings'

const queryClient = new QueryClient()

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <SettingsProvider>
        <Header />
        <QueryClientProvider client={queryClient}>
          <div className="min-h-screen">
            {children}
          </div>
        </QueryClientProvider>
      </SettingsProvider>
    </ThemeProvider>
  )
}
