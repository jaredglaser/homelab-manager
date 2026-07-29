import { describe, it, expect, mock } from 'bun:test'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MANAGED_HOST_NAMES_QUERY_KEY, STACKS_QUERY_KEY } from '@/lib/constants/stacks-keys'
import type { StackSummary } from '@/types/stacks'

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

function stackSummary(name: string): StackSummary {
  return {
    name,
    host: 'server1',
    icon: null,
    syncStatus: 'unknown',
    deployMode: 'auto',
    lastDeployAt: null,
    lastDeployStatus: null,
    containerCount: 0,
  }
}

const TWO_STACKS = [stackSummary('plex'), stackSummary('authentik')]

function renderNav(hosts: string[] = ['tank', 'nas'], stacks: StackSummary[] = TWO_STACKS) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  qc.setQueryData(MANAGED_HOST_NAMES_QUERY_KEY, hosts)
  qc.setQueryData(STACKS_QUERY_KEY, stacks)
  return render(
    <QueryClientProvider client={qc}>
      <MobileNav />
    </QueryClientProvider>,
  )
}

async function openDrawer(hosts?: string[], stacks?: StackSummary[]) {
  renderNav(hosts, stacks)
  fireEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }))
  await screen.findByRole('link', { name: /zfs/i })
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

    for (const label of ['ZFS', 'Proxmox']) {
      expect(screen.getByRole('link', { name: new RegExp(label, 'i') })).not.toBeNull()
    }
    for (const label of ['Docker', 'Stacks', 'Settings']) {
      expect(screen.getByRole('button', { name: new RegExp(label, 'i') })).not.toBeNull()
    }
  })

  it('marks the active route', async () => {
    await openDrawer()
    const dockerRow = screen.getByRole('button', { name: /docker/i })
    expect(dockerRow.getAttribute('aria-current')).toBe('page')
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

  it('expands a submenu when its row is tapped', async () => {
    await openDrawer()
    const settingsRow = screen.getByRole('button', { name: /settings/i })
    expect(settingsRow.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(settingsRow)

    expect(settingsRow.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('menuitem', { name: /developer/i })).not.toBeNull()
  })

  it('does not navigate or close the drawer when a submenu row is tapped', async () => {
    await openDrawer()
    const settingsRow = screen.getByRole('button', { name: /settings/i })
    expect(settingsRow.tagName).toBe('BUTTON')

    fireEvent.click(settingsRow)

    expect(screen.getByRole('link', { name: /zfs/i })).not.toBeNull()
  })

  it('collapses an expanded submenu when its row is tapped again', async () => {
    await openDrawer()
    const dockerRow = screen.getByRole('button', { name: /docker/i })
    expect(dockerRow.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(dockerRow)

    expect(dockerRow.getAttribute('aria-expanded')).toBe('false')
  })

  it('expands a route with a single destination', async () => {
    await openDrawer(['tank'])
    expect(await screen.findByRole('menuitem', { name: /tank/i })).not.toBeNull()
  })

  it('leaves a route with nothing to list a plain link', async () => {
    await openDrawer([])
    expect(screen.getByRole('link', { name: /docker/i })).not.toBeNull()
  })

  it('lists the stacks route itself alongside its stacks', async () => {
    await openDrawer()

    fireEvent.click(screen.getByRole('button', { name: /stacks/i }))

    const allStacks = screen.getByRole('menuitem', { name: /all stacks/i })
    expect(allStacks.getAttribute('href')).toBe('/stacks')
  })

  it('gives the docker menu no self entry, since every host lands on the route', async () => {
    await openDrawer()
    const items = screen.getAllByRole('menuitem').map((el) => el.getAttribute('href'))
    expect(items).not.toContain('/docker')
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

  it('closes the drawer from the header close button', async () => {
    await openDrawer()

    fireEvent.click(screen.getByRole('button', { name: 'Close navigation menu' }))

    await waitFor(() => expect(screen.queryByRole('link', { name: /zfs/i })).toBeNull())
  })

  it('repeats the current route label in the drawer header', async () => {
    await openDrawer()
    const headerRow = screen.getByRole('button', { name: 'Close navigation menu' }).parentElement

    expect(within(headerRow!).getByText('Docker').getAttribute('aria-hidden')).toBe('true')
  })

  it('names the drawer for assistive tech, not for the current route', async () => {
    await openDrawer()
    expect(screen.getByRole('dialog', { name: 'Main navigation' })).not.toBeNull()
  })

  it('gives the close button a 44px touch target', async () => {
    await openDrawer()
    expect(
      screen.getByRole('button', { name: 'Close navigation menu' }).className,
    ).toContain('size-11')
  })
})
