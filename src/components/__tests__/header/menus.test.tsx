import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
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
} = await import('@/components/header/menus')

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
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
  it('shows loading state', () => {
    mockListStacks.mockImplementation(() => new Promise(() => {}))
    render(<StacksMenuContent />, { wrapper: createWrapper() })
    expect(screen.getByText('Loading…')).not.toBeNull()
  })

  it('shows error state', async () => {
    mockListStacks.mockImplementation(() => Promise.reject(new Error('fail')))
    const { findByText } = render(<StacksMenuContent />, { wrapper: createWrapper() })
    expect(await findByText('Failed to load stacks')).not.toBeNull()
  })

  it('shows empty state when no stacks', async () => {
    mockListStacks.mockImplementation(() => Promise.resolve([]))
    const { findByText } = render(<StacksMenuContent />, { wrapper: createWrapper() })
    expect(await findByText('No stacks')).not.toBeNull()
  })

  it('renders stacks sorted by name', async () => {
    mockListStacks.mockImplementation(() =>
      Promise.resolve([
        { name: 'zabbix', host: 'server1', icon: null, deployMode: 'auto', lastDeployAt: null, lastDeployStatus: null, containerCount: 0 },
        { name: 'authentik', host: 'server1', icon: null, deployMode: 'auto', lastDeployAt: null, lastDeployStatus: null, containerCount: 0 },
        { name: 'plex', host: 'server1', icon: null, deployMode: 'auto', lastDeployAt: null, lastDeployStatus: null, containerCount: 0 },
      ]),
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
      Promise.resolve([
        { name: 'nginx', host: 'server1', icon: 'nginx', deployMode: 'auto', lastDeployAt: null, lastDeployStatus: null, containerCount: 0 },
        { name: 'plex', host: 'server1', icon: null, deployMode: 'auto', lastDeployAt: null, lastDeployStatus: null, containerCount: 0 },
      ]),
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
    mockListStacks.mockImplementation(() =>
      Promise.resolve([{ name: 'plex', host: 'server1', icon: null, deployMode: 'auto', lastDeployAt: null, lastDeployStatus: null, containerCount: 0 }]),
    )
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
    mockListStacks.mockImplementation(() =>
      Promise.resolve([
        { name: 'plex', host: 'server1', icon: null, deployMode: 'auto', lastDeployAt: null, lastDeployStatus: null, containerCount: 0 },
      ]),
    )
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
  it('shows loading state', () => {
    mockListManagedHostNames.mockImplementation(() => new Promise(() => {}))
    render(<DockerHostsMenuContent />, { wrapper: createWrapper() })
    expect(screen.getByText('Loading…')).not.toBeNull()
  })

  it('shows error state', async () => {
    mockListManagedHostNames.mockImplementation(() => Promise.reject(new Error('fail')))
    const { findByText } = render(<DockerHostsMenuContent />, { wrapper: createWrapper() })
    expect(await findByText('Failed to load hosts')).not.toBeNull()
  })

  it('shows empty state when no hosts', async () => {
    mockListManagedHostNames.mockImplementation(() => Promise.resolve([]))
    const { findByText } = render(<DockerHostsMenuContent />, { wrapper: createWrapper() })
    expect(await findByText('No hosts')).not.toBeNull()
  })

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

  it('renders StacksMenuContent for /stacks', () => {
    mockListStacks.mockImplementation(() => new Promise(() => {}))
    render(<MenuContentFor to="/stacks" />, { wrapper: createWrapper() })
    expect(screen.getByText('Loading…')).not.toBeNull()
  })

  it('renders DockerHostsMenuContent for /docker', () => {
    mockListManagedHostNames.mockImplementation(() => new Promise(() => {}))
    render(<MenuContentFor to="/docker" />, { wrapper: createWrapper() })
    expect(screen.getByText('Loading…')).not.toBeNull()
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
