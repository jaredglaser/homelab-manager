import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { render, renderHook, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MANAGED_HOST_NAMES_QUERY_KEY, STACKS_QUERY_KEY } from '@/lib/constants/stacks-keys'
import type { StackSummary } from '@/types/stacks'
import type { MenuRouteKey } from '@/components/header/nav-config'

const mockListStacks = mock((): Promise<StackSummary[]> => Promise.resolve([]))
const mockListManagedHostNames = mock((): Promise<string[]> => Promise.resolve([]))

mock.module('@/data/stacks/functions', () => ({
  listStacks: mockListStacks,
  listManagedHostNames: mockListManagedHostNames,
  createStack: mock(() => Promise.resolve({})),
}))

mock.module('@/lib/utils/icon-resolver', () => ({
  getIconUrl: (_icon: string, _fallback: string) => `/icons/${_icon}.png`,
  FALLBACK_ICON_URL: '/fallback.png',
  AVAILABLE_ICONS: [],
}))

mock.module('@/lib/query-client', () => ({
  queryClient: { prefetchQuery: mock(() => Promise.resolve()) },
}))

mock.module('@/lib/constants/preload-queries', () => ({
  DOCKER_PRELOAD_KEY: ['preload', 'docker-stats'],
  ZFS_PRELOAD_KEY: ['preload', 'zfs-stats'],
  PROXMOX_PRELOAD_KEY: ['preload', 'proxmox-stats'],
  preloadDockerStats: mock(() => Promise.resolve([])),
  preloadZFSStats: mock(() => Promise.resolve([])),
  preloadProxmoxStats: mock(() => Promise.resolve([])),
}))

// Render Link as a plain anchor so tests don't need a full router context.
// params substitutes $key placeholders so hrefs reflect the actual resolved path.
mock.module('@tanstack/react-router', () => ({
  Link: ({ children, to, hash, params, onClick, ...rest }: {
    children: React.ReactNode
    to: string
    hash?: string
    params?: Record<string, string>
    onClick?: () => void
    [key: string]: unknown
  }) => {
    let resolvedTo = to
    if (params) {
      for (const [key, val] of Object.entries(params)) {
        resolvedTo = resolvedTo.replace(`$${key}`, val)
      }
    }
    const href = hash ? `${resolvedTo}#${hash}` : resolvedTo
    return <a href={href} onClick={onClick} {...rest}>{children}</a>
  },
  useLocation: ({ select }: { select: (l: { pathname: string }) => string }) =>
    select({ pathname: '/docker' }),
  useNavigate: () => mock(() => {}),
}))

const {
  NavMenuCloseContext,
  SettingsMenuContent,
  StacksMenuContent,
  DockerHostsMenuContent,
  MenuContentFor,
  shouldRenderMenu,
  useMenuRoutes,
} = await import('@/components/header/menus')

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

function stackSummary(name: string, icon: string | null = null): StackSummary {
  return {
    name,
    host: 'server1',
    icon,
    syncStatus: 'unknown',
    deployMode: 'auto',
    lastDeployAt: null,
    lastDeployStatus: null,
    containerCount: 0,
  }
}

beforeEach(() => {
  mockListStacks.mockClear()
  mockListManagedHostNames.mockClear()
  mockListStacks.mockImplementation(() => Promise.resolve([]))
  mockListManagedHostNames.mockImplementation(() => Promise.resolve([]))
})

describe('SettingsMenuContent', () => {
  it('renders one link per SETTINGS_SECTIONS entry (6 total)', () => {
    const { container } = render(<SettingsMenuContent />, { wrapper: createWrapper() })
    const links = container.querySelectorAll('a')
    expect(links.length).toBe(6)
  })

  it('calls close context when a link is clicked', () => {
    const closeSpy = mock(() => {})
    render(
      <NavMenuCloseContext value={closeSpy}>
        <SettingsMenuContent />
      </NavMenuCloseContext>,
      { wrapper: createWrapper() },
    )
    const links = screen.getAllByRole('menuitem')
    fireEvent.click(links[0])
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('renders each section label', () => {
    render(<SettingsMenuContent />, { wrapper: createWrapper() })
    expect(screen.getByText('General')).not.toBeNull()
    expect(screen.getByText('Docker Dashboard')).not.toBeNull()
    expect(screen.getByText('ZFS Dashboard')).not.toBeNull()
    expect(screen.getByText('Data Retention')).not.toBeNull()
    expect(screen.getByText('Managed Hosts')).not.toBeNull()
    expect(screen.getByText('Developer')).not.toBeNull()
  })

  it('renders links with hash matching each section id', () => {
    const { container } = render(<SettingsMenuContent />, { wrapper: createWrapper() })
    const links = Array.from(container.querySelectorAll('a'))
    const expectedHashes = ['general', 'docker-dashboard', 'zfs-dashboard', 'data-retention', 'managed-hosts', 'developer']
    expectedHashes.forEach((hash, i) => {
      expect(links[i].getAttribute('href')).toBe(`/settings#${hash}`)
    })
  })
})

describe('StacksMenuContent', () => {
  it('renders stacks sorted by name', async () => {
    mockListStacks.mockImplementation(() =>
      Promise.resolve([stackSummary('zabbix'), stackSummary('authentik'), stackSummary('plex')]),
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { findAllByRole } = render(
      <QueryClientProvider client={qc}>
        <StacksMenuContent />
      </QueryClientProvider>,
    )
    const items = await findAllByRole('menuitem')
    // Verify the three stacks appear in alphabetical order by their text content
    expect(items[0].textContent).toContain('authentik')
    expect(items[1].textContent).toContain('plex')
    expect(items[2].textContent).toContain('zabbix')
  })

  it('renders <img> for stacks with icon and <span> placeholder for stacks with null icon', async () => {
    mockListStacks.mockImplementation(() =>
      Promise.resolve([stackSummary('nginx', 'nginx'), stackSummary('plex')]),
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { findAllByRole } = render(
      <QueryClientProvider client={qc}>
        <StacksMenuContent />
      </QueryClientProvider>,
    )
    const items = await findAllByRole('menuitem')
    // nginx comes before plex alphabetically, so items[0] = nginx (has icon), items[1] = plex (no icon)
    const nginxImg = items[0].querySelector('img')
    expect(nginxImg).not.toBeNull()
    expect(nginxImg?.getAttribute('src')).toBeTruthy()

    const plexImg = items[1].querySelector('img')
    expect(plexImg).toBeNull()
    // placeholder shows the uppercased first character of the stack name
    expect(items[1].textContent).toContain('P')
  })

  it('calls close context when a stack link is clicked', async () => {
    const closeSpy = mock(() => {})
    mockListStacks.mockImplementation(() => Promise.resolve([stackSummary('plex')]))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { findAllByRole } = render(
      <QueryClientProvider client={qc}>
        <NavMenuCloseContext value={closeSpy}>
          <StacksMenuContent />
        </NavMenuCloseContext>
      </QueryClientProvider>,
    )
    const items = await findAllByRole('menuitem')
    fireEvent.click(items[0])
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('renders links with the stack name resolved in the href', async () => {
    mockListStacks.mockImplementation(() => Promise.resolve([stackSummary('plex')]))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { findAllByRole } = render(
      <QueryClientProvider client={qc}>
        <StacksMenuContent />
      </QueryClientProvider>,
    )
    const items = await findAllByRole('menuitem')
    expect(items[0].getAttribute('href')).toBe('/stacks/plex')
  })
})

describe('DockerHostsMenuContent', () => {
  it('renders host names', async () => {
    mockListManagedHostNames.mockImplementation(() =>
      Promise.resolve(['server1', 'server2']),
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { findByText } = render(
      <QueryClientProvider client={qc}>
        <DockerHostsMenuContent />
      </QueryClientProvider>,
    )
    expect(await findByText('server1')).not.toBeNull()
    expect(await findByText('server2')).not.toBeNull()
  })

  it('renders links with hash="host-${name}" in the href', async () => {
    mockListManagedHostNames.mockImplementation(() =>
      Promise.resolve(['server1', 'server2']),
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { findAllByRole } = render(
      <QueryClientProvider client={qc}>
        <DockerHostsMenuContent />
      </QueryClientProvider>,
    )
    const items = await findAllByRole('menuitem')
    // The Link mock renders <a href="${to}#${hash}">; verify the fragment is present
    expect(items[0].getAttribute('href')).toContain('host-server1')
    expect(items[1].getAttribute('href')).toContain('host-server2')
  })

  it('calls close context when a host link is clicked', async () => {
    const closeSpy = mock(() => {})
    mockListManagedHostNames.mockImplementation(() => Promise.resolve(['server1']))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { findAllByRole } = render(
      <QueryClientProvider client={qc}>
        <NavMenuCloseContext value={closeSpy}>
          <DockerHostsMenuContent />
        </NavMenuCloseContext>
      </QueryClientProvider>,
    )
    const items = await findAllByRole('menuitem')
    fireEvent.click(items[0])
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })
})

describe('MenuContentFor', () => {
  it('renders SettingsMenuContent for /settings', () => {
    render(<MenuContentFor to="/settings" />, { wrapper: createWrapper() })
    expect(screen.getByText('General')).not.toBeNull()
  })

  it('renders StacksMenuContent for /stacks', async () => {
    mockListStacks.mockImplementation(() => Promise.resolve([stackSummary('plex')]))
    const { findByText } = render(<MenuContentFor to="/stacks" />, { wrapper: createWrapper() })
    expect(await findByText('plex')).not.toBeNull()
  })

  it('renders DockerHostsMenuContent for /docker', async () => {
    mockListManagedHostNames.mockImplementation(() => Promise.resolve(['server1']))
    const { findByText } = render(<MenuContentFor to="/docker" />, { wrapper: createWrapper() })
    expect(await findByText('server1')).not.toBeNull()
  })

  it('renders nothing for an unknown route key', () => {
    // Cast to bypass TypeScript so we can reach the null fallback branch.
    const { container } = render(
      <MenuContentFor to={'/proxmox' as MenuRouteKey} />,
      { wrapper: createWrapper() },
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('shouldRenderMenu', () => {
  it('withholds the menu only from a route with nothing to list', () => {
    expect(shouldRenderMenu(0)).toBe(false)
    expect(shouldRenderMenu(1)).toBe(true)
  })
})

describe('useMenuRoutes', () => {
  function renderMenuRoutes(stacks: StackSummary[], hosts: string[]) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(STACKS_QUERY_KEY, stacks)
    queryClient.setQueryData(MANAGED_HOST_NAMES_QUERY_KEY, hosts)
    return renderHook(() => useMenuRoutes(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    })
  }

  it('always includes /settings, whose sections are fixed', () => {
    const { result } = renderMenuRoutes([], [])
    expect(result.current.has('/settings')).toBe(true)
  })

  it('excludes routes with nothing to list', () => {
    const { result } = renderMenuRoutes([], [])
    expect(result.current.has('/stacks')).toBe(false)
    expect(result.current.has('/docker')).toBe(false)
  })

  it('includes routes down to a single entry', () => {
    const { result } = renderMenuRoutes([stackSummary('plex')], ['server1'])
    expect(result.current.has('/stacks')).toBe(true)
    expect(result.current.has('/docker')).toBe(true)
  })
})
