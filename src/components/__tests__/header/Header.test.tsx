import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MANAGED_HOST_NAMES_QUERY_KEY, STACKS_QUERY_KEY } from '@/lib/constants/stacks-keys'

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

mock.module('@/lib/query-client', () => ({
  queryClient: { prefetchQuery: mock(() => Promise.resolve()) },
}))

mock.module('@/data/stacks/functions', () => ({
  listStacks: mock(() => Promise.resolve([])),
  listManagedHostNames: mock(() => Promise.resolve([])),
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
  getIconUrl: (_icon: string, _fallback: string) => `/icons/${_icon}.png`,
  FALLBACK_ICON_URL: '/fallback.png',
  AVAILABLE_ICONS: [],
}))

// ModeToggle calls useColorScheme which requires the MUI theme provider.
// Replace it with a no-op to keep the smoke test free of provider boilerplate.
mock.module('@/components/ModeToggle', () => ({
  default: () => <button aria-label="Toggle dark mode" />,
}))

// IS_DEMO_MODE is a module-level const captured at import time. Tests that need
// it true must import Header in a separate file (see Header.demo.test.tsx).
mock.module('@/lib/constants/demo', () => ({ IS_DEMO_MODE: false }))

const Header = (await import('@/components/header/Header')).default

// Hosts seeded by default: a route with nothing to list gets no dropdown, so
// without the seed no tab here would open a menu at all.
function createWrapper(hosts: string[] = ['tank', 'nas']) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  qc.setQueryData(MANAGED_HOST_NAMES_QUERY_KEY, hosts)
  qc.setQueryData(STACKS_QUERY_KEY, [])
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

function findDockerTab() {
  const tab = screen.getAllByRole('tab').find((t) => t.textContent?.includes('Docker'))
  expect(tab).not.toBeUndefined()
  return tab!
}

describe('Header', () => {
  it('renders all five nav tab labels', () => {
    render(<Header />, { wrapper: createWrapper() })
    expect(screen.getByText('Docker')).not.toBeNull()
    expect(screen.getByText('Stacks')).not.toBeNull()
    expect(screen.getByText('ZFS')).not.toBeNull()
    expect(screen.getByText('Proxmox')).not.toBeNull()
    expect(screen.getByText('Settings')).not.toBeNull()
  })

  it('marks the active tab aria-selected based on the mocked pathname (/docker)', () => {
    render(<Header />, { wrapper: createWrapper() })
    // MUI Tabs sets aria-selected="true" on the currently selected Tab button.
    // The Docker tab text is inside a span inside the button; query by role.
    const dockerTab = findDockerTab()
    expect(dockerTab.getAttribute('aria-selected')).toBe('true')
  })

  it('does not render the demo banner when IS_DEMO_MODE is false', () => {
    render(<Header />, { wrapper: createWrapper() })
    expect(screen.queryByText('Demo mode')).toBeNull()
  })

  it('renders the account menu button when a non-synthetic user is provided', () => {
    render(
      <Header user={{ id: 1, email: 'alice@example.com', name: 'Alice', role: 'admin' }} />,
      { wrapper: createWrapper() },
    )
    expect(screen.getByRole('button', { name: 'Account menu' })).not.toBeNull()
  })

  it('advertises a dropdown on a tab with something to list', () => {
    render(<Header />, { wrapper: createWrapper(['tank']) })
    expect(findDockerTab().getAttribute('aria-haspopup')).toBe('menu')
  })

  it('leaves a tab with nothing to list a plain link', () => {
    render(<Header />, { wrapper: createWrapper([]) })
    const dockerTab = findDockerTab()
    expect(dockerTab.getAttribute('aria-haspopup')).toBeNull()

    fireEvent.mouseEnter(dockerTab)

    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes the open menu when Escape is pressed on a menu tab', () => {
    render(<Header />, { wrapper: createWrapper() })
    const dockerTab = findDockerTab()
    fireEvent.mouseEnter(dockerTab)
    // Assert the menu is actually open before pressing Escape, so the test
    // verifies the open → close transition rather than passing vacuously.
    expect(screen.getByRole('menu')).not.toBeNull()
    fireEvent.keyDown(dockerTab, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  // requestClose() schedules close via setTimeout (MENU_CLOSE_DELAY_MS = 120ms).
  // Fake setTimeout so tests flush the timer synchronously rather than waiting real time.
  describe('delayed-close event handlers', () => {
    const origSetTimeout = globalThis.setTimeout
    const origClearTimeout = globalThis.clearTimeout
    let pendingCallbacks: Array<{ fn: () => void; id: number }> = []
    let nextTimerId = 1000

    beforeEach(() => {
      pendingCallbacks = []
      nextTimerId = 1000
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(globalThis as any).setTimeout = (fn: () => void) => {
        const id = nextTimerId++
        pendingCallbacks.push({ fn, id })
        return id
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(globalThis as any).clearTimeout = (id?: number) => {
        pendingCallbacks = pendingCallbacks.filter((cb) => cb.id !== id)
      }
    })

    afterEach(() => {
      globalThis.setTimeout = origSetTimeout
      globalThis.clearTimeout = origClearTimeout
    })

    function flushTimers() {
      const cbs = [...pendingCallbacks]
      pendingCallbacks = []
      for (const cb of cbs) cb.fn()
    }

    it('closes the open menu when mouse leaves a menu tab', () => {
      render(<Header />, { wrapper: createWrapper() })
      const dockerTab = findDockerTab()
      fireEvent.mouseEnter(dockerTab)
      expect(screen.getByRole('menu')).not.toBeNull()
      fireEvent.mouseLeave(dockerTab)
      act(() => { flushTimers() })
      expect(screen.queryByRole('menu')).toBeNull()
    })

    it('opens the menu when a menu tab receives focus', () => {
      render(<Header />, { wrapper: createWrapper() })
      const dockerTab = findDockerTab()
      fireEvent.focus(dockerTab)
      expect(screen.getByRole('menu')).not.toBeNull()
    })

    it('closes the open menu when a menu tab loses focus', () => {
      render(<Header />, { wrapper: createWrapper() })
      const dockerTab = findDockerTab()
      fireEvent.focus(dockerTab)
      expect(screen.getByRole('menu')).not.toBeNull()
      fireEvent.blur(dockerTab)
      act(() => { flushTimers() })
      expect(screen.queryByRole('menu')).toBeNull()
    })
  })
})
