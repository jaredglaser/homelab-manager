import { describe, it, expect, mock, beforeAll, afterAll } from 'bun:test'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

mock.module('@tanstack/react-router', () => ({
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
    select({ pathname: '/zfs' }),
}))

mock.module('@/lib/query-client', () => ({
  queryClient: { prefetchQuery: mock(() => Promise.resolve()) },
}))

mock.module('@/data/stacks/functions', () => ({
  listStacks: mock(() => Promise.resolve([])),
  listManagedHostNames: mock(() => Promise.resolve(['tank'])),
  createStack: mock(() => Promise.resolve({})),
}))

mock.module('@/lib/constants/preload-queries', () => ({
  DOCKER_PRELOAD_KEY: ['preload', 'docker-stats'],
  ZFS_PRELOAD_KEY: ['preload', 'zfs-stats'],
  PROXMOX_PRELOAD_KEY: ['preload', 'proxmox-stats'],
  preloadDockerStats: mock(() => Promise.resolve([])),
  preloadZFSStats: mock(() => Promise.resolve([])),
  preloadProxmoxStats: mock(() => Promise.resolve([])),
}))

mock.module('@/lib/utils/icon-resolver', () => ({
  getIconUrl: (icon: string) => `/icons/${icon}.png`,
  FALLBACK_ICON_URL: '/fallback.png',
  AVAILABLE_ICONS: [],
}))

mock.module('@/components/ModeToggle', () => ({
  default: () => <button aria-label="Toggle dark mode" />,
}))

mock.module('@/lib/constants/demo', () => ({ IS_DEMO_MODE: false }))

const originalMatchMedia = window.matchMedia

// Touch but wide enough to keep the tab bar: the tablet band, where the drawer
// never renders and hover can never fire.
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === '(hover: none), (pointer: coarse)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  })
})

afterAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  })
})

const Header = (await import('@/components/header/Header')).default

function renderHeader() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  // Seeded, not fetched: downstream the header derives which routes own a menu
  // from this data, so an unresolved query renders every tab menu-less.
  qc.setQueryData(['managed-host-names'], ['tank'])
  return render(
    <QueryClientProvider client={qc}>
      <Header user={{ id: 1, email: 'alice@example.com', name: 'Alice', role: 'admin' }} />
    </QueryClientProvider>,
  )
}

describe('Header on a touch device above the compact breakpoint', () => {
  it('keeps the tab bar rather than the drawer', () => {
    renderHeader()
    expect(screen.queryByRole('button', { name: 'Open navigation menu' })).toBeNull()
    expect(screen.getByRole('tab', { name: /docker/i })).not.toBeNull()
  })

  it('does not open a submenu on hover, which touch can never fire', () => {
    renderHeader()
    const dockerTab = screen.getByRole('tab', { name: /docker/i })

    fireEvent.mouseEnter(dockerTab)

    expect(dockerTab.getAttribute('aria-expanded')).toBe('false')
  })

  it('does not open a submenu on focus either', () => {
    renderHeader()
    const dockerTab = screen.getByRole('tab', { name: /docker/i })

    fireEvent.focus(dockerTab)

    expect(dockerTab.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens a submenu on tap, the only gesture touch has', () => {
    renderHeader()
    const dockerTab = screen.getByRole('tab', { name: /docker/i })

    fireEvent.click(dockerTab)

    expect(dockerTab.getAttribute('aria-expanded')).toBe('true')
  })

  it('closes an open submenu on an outside press', () => {
    renderHeader()
    const dockerTab = screen.getByRole('tab', { name: /docker/i })
    fireEvent.click(dockerTab)
    expect(dockerTab.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(document.body)

    expect(dockerTab.getAttribute('aria-expanded')).toBe('false')
  })

  it('leaves a route without a submenu unexpanded on tap', () => {
    renderHeader()
    const zfsTab = screen.getByRole('tab', { name: /zfs/i })

    fireEvent.click(zfsTab)

    expect(zfsTab.getAttribute('aria-expanded')).toBeNull()
  })
})
