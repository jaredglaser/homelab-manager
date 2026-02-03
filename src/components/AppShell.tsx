import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ThemeProvider from './ThemeProvider'
import Header from './Header'

const queryClient = new QueryClient()

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <Header />
      <QueryClientProvider client={queryClient}>
        <div className="min-h-screen">
          {children}
        </div>
      </QueryClientProvider>
    </ThemeProvider>
  )
}
