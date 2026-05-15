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

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
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
    const tabs = screen.getAllByRole('tab')
    const dockerTab = tabs.find((t) => t.textContent?.includes('Docker'))
    expect(dockerTab).not.toBeNull()
    expect(dockerTab?.getAttribute('aria-selected')).toBe('true')
  })

  it('does not render the demo banner when IS_DEMO_MODE is false', () => {
    render(<Header />, { wrapper: createWrapper() })
    expect(screen.queryByText('Demo mode')).toBeNull()
  })

  it('closes the open menu when Escape is pressed on a menu tab', () => {
    render(<Header />, { wrapper: createWrapper() })
    const tabs = screen.getAllByRole('tab')
    const dockerTab = tabs.find((t) => t.textContent?.includes('Docker'))
    expect(dockerTab).not.toBeNull()
    fireEvent.mouseEnter(dockerTab!)
    // Assert the menu is actually open before pressing Escape, so the test
    // verifies the open → close transition rather than passing vacuously.
    expect(screen.getByRole('menu')).not.toBeNull()
    fireEvent.keyDown(dockerTab!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes the open menu when mouse leaves a menu tab', async () => {
    render(<Header />, { wrapper: createWrapper() })
    const tabs = screen.getAllByRole('tab')
    const dockerTab = tabs.find((t) => t.textContent?.includes('Docker'))
    expect(dockerTab).not.toBeNull()
    fireEvent.mouseEnter(dockerTab!)
    expect(screen.getByRole('menu')).not.toBeNull()
    fireEvent.mouseLeave(dockerTab!)
    // requestClose() closes after MENU_CLOSE_DELAY_MS (120ms); waitFor retries until closed
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('opens the menu when a menu tab receives focus', () => {
    render(<Header />, { wrapper: createWrapper() })
    const tabs = screen.getAllByRole('tab')
    const dockerTab = tabs.find((t) => t.textContent?.includes('Docker'))
    expect(dockerTab).not.toBeNull()
    fireEvent.focus(dockerTab!)
    expect(screen.getByRole('menu')).not.toBeNull()
  })

  it('closes the open menu when a menu tab loses focus', async () => {
    render(<Header />, { wrapper: createWrapper() })
    const tabs = screen.getAllByRole('tab')
    const dockerTab = tabs.find((t) => t.textContent?.includes('Docker'))
    expect(dockerTab).not.toBeNull()
    fireEvent.focus(dockerTab!)
    expect(screen.getByRole('menu')).not.toBeNull()
    fireEvent.blur(dockerTab!)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })
})
