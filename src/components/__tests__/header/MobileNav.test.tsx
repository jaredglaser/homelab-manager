import { describe, it, expect, mock } from 'bun:test'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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
    select({ pathname: '/docker' }),
}))

const prefetchQuery = mock(() => Promise.resolve())
mock.module('@/lib/query-client', () => ({ queryClient: { prefetchQuery } }))

mock.module('@/data/stacks/functions', () => ({
  listStacks: mock(() => Promise.resolve([])),
  listManagedHostNames: mock(() => Promise.resolve(['tank', 'nas'])),
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

const MobileNav = (await import('@/components/header/MobileNav')).default

function renderNav() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <MobileNav />
    </QueryClientProvider>,
  )
}

async function openDrawer() {
  renderNav()
  fireEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }))
  await screen.findByRole('link', { name: /docker/i })
}

describe('MobileNav', () => {
  it('shows the current route label beside the trigger', () => {
    renderNav()
    expect(screen.getByText('Docker')).not.toBeNull()
  })

  it('keeps the drawer closed until the trigger is tapped', () => {
    renderNav()
    const trigger = screen.getByRole('button', { name: 'Open navigation menu' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Homelab Manager')).toBeNull()
  })

  it('opens a drawer listing every nav destination', async () => {
    await openDrawer()

    for (const label of ['Docker', 'Stacks', 'ZFS', 'Proxmox', 'Settings']) {
      expect(screen.getByRole('link', { name: new RegExp(label, 'i') })).not.toBeNull()
    }
  })

  it('marks the active route', async () => {
    await openDrawer()
    const dockerLink = screen.getByRole('link', { name: /docker/i })
    expect(dockerLink.getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: /zfs/i }).getAttribute('aria-current')).toBeNull()
  })

  it('gives every nav link a 48px minimum tap target', async () => {
    await openDrawer()
    expect(screen.getByRole('link', { name: /zfs/i }).className).toContain('min-h-12')
  })

  it('auto-expands the submenu of the current route', async () => {
    await openDrawer()
    expect(await screen.findByRole('menuitem', { name: /tank/i })).not.toBeNull()
  })

  it('toggles a submenu from its disclosure button', async () => {
    await openDrawer()
    const toggle = screen.getByRole('button', { name: /expand stacks menu/i })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)

    expect(
      screen.getByRole('button', { name: /collapse stacks menu/i }).getAttribute('aria-expanded'),
    ).toBe('true')
  })

  it('offers no disclosure button for routes without a submenu', async () => {
    await openDrawer()
    expect(screen.queryByRole('button', { name: /zfs menu/i })).toBeNull()
  })

  it('closes the drawer and prefetches when a destination is tapped', async () => {
    await openDrawer()
    prefetchQuery.mockClear()

    fireEvent.click(screen.getByRole('link', { name: /zfs/i }))

    await waitFor(() => expect(screen.queryByRole('link', { name: /zfs/i })).toBeNull())
    expect(prefetchQuery).toHaveBeenCalled()
  })

  it('closes the drawer when a submenu entry is tapped', async () => {
    await openDrawer()
    const hostLink = await screen.findByRole('menuitem', { name: /nas/i })

    fireEvent.click(hostLink)

    await waitFor(() => expect(screen.queryByRole('menuitem', { name: /nas/i })).toBeNull())
  })
})
