import { describe, it, expect, mock } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { mockModule } from '@/lib/test/mock-module';

mockModule<typeof import('@tanstack/react-router')>('@tanstack/react-router', (real) => ({ ...real, 
  Link: ({ children, to, hash, onClick, ...rest }: {
    children: React.ReactNode
    to: string
    hash?: string
    onClick?: () => void
    [key: string]: unknown
  }) => {
    const href = hash ? `${to}#${hash}` : to
    return <a href={href} onClick={onClick} {...rest}>{children}</a>
  },
  useLocation: ({ select }: { select: (l: { pathname: string }) => string }) =>
    select({ pathname: '/docker' }),
}))

mockModule<typeof import('@/lib/query-client')>('@/lib/query-client', (real) => ({ ...real, 
  queryClient: { prefetchQuery: mock(() => Promise.resolve()) },
}))

mockModule<typeof import('@/data/stacks/functions')>('@/data/stacks/functions', (real) => ({ ...real, 
  listStacks: mock(() => Promise.resolve([])),
  listManagedHostNames: mock(() => Promise.resolve([])),
  createStack: mock(() => Promise.resolve({})),
}))

mockModule<typeof import('@/lib/constants/preload-queries')>('@/lib/constants/preload-queries', (real) => ({ ...real, 
  DOCKER_PRELOAD_KEY: ['preload', 'docker-stats'],
  ZFS_PRELOAD_KEY: ['preload', 'zfs-stats'],
  PROXMOX_PRELOAD_KEY: ['preload', 'proxmox-stats'],
  preloadDockerStats: mock(() => Promise.resolve([])),
  preloadZFSStats: mock(() => Promise.resolve([])),
  preloadProxmoxStats: mock(() => Promise.resolve([])),
}))

mockModule<typeof import('@/lib/utils/icon-resolver')>('@/lib/utils/icon-resolver', (real) => ({ ...real, 
  getIconUrl: (_icon: string, _fallback: string) => `/icons/${_icon}.png`,
  FALLBACK_ICON_URL: '/fallback.png',
  AVAILABLE_ICONS: [],
}))

mock.module('@/components/ModeToggle', () => ({
  default: () => <button aria-label="Toggle dark mode" />,
}))

// IS_DEMO_MODE must be set before Header is imported so the cached constant is true.
mockModule<typeof import('@/lib/constants/demo')>('@/lib/constants/demo', (real) => ({ ...real,  IS_DEMO_MODE: true }))

const Header = (await import('@/components/header/Header')).default

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

describe('Header (demo mode)', () => {
  it('renders the demo banner when IS_DEMO_MODE is true', () => {
    render(<Header />, { wrapper: createWrapper() })
    expect(screen.queryByText('Demo mode')).not.toBeNull()
  })
})
