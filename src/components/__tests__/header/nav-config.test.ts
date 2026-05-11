import { describe, it, expect, mock, beforeEach } from 'bun:test'

const mockPrefetchQuery = mock(() => Promise.resolve())

mock.module('@/lib/query-client', () => ({
  queryClient: {
    prefetchQuery: mockPrefetchQuery,
  },
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

const { NAV_ITEMS, SETTINGS_SECTIONS, PREFETCH_STALE_TIME, handlePrefetch } = await import('@/components/header/nav-config')

beforeEach(() => {
  mockPrefetchQuery.mockClear()
})

describe('NAV_ITEMS', () => {
  it('has exactly 5 entries', () => {
    expect(NAV_ITEMS.length).toBe(5)
  })

  it('has the correct routes', () => {
    const routes = NAV_ITEMS.map((i) => i.to)
    expect(routes).toEqual(['/docker', '/stacks', '/zfs', '/proxmox', '/settings'])
  })

  it('has correct hasMenu flags', () => {
    const byRoute = Object.fromEntries(NAV_ITEMS.map((i) => [i.to, i.hasMenu]))
    expect(byRoute['/docker']).toBe(true)
    expect(byRoute['/stacks']).toBe(true)
    expect(byRoute['/zfs']).toBe(false)
    expect(byRoute['/proxmox']).toBe(false)
    expect(byRoute['/settings']).toBe(true)
  })
})

describe('SETTINGS_SECTIONS', () => {
  it('has exactly 6 entries', () => {
    expect(SETTINGS_SECTIONS.length).toBe(6)
  })

  it('has the expected ids in order', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id)
    expect(ids).toEqual([
      'general',
      'docker-dashboard',
      'zfs-dashboard',
      'data-retention',
      'managed-hosts',
      'developer',
    ])
  })
})

describe('PREFETCH_STALE_TIME', () => {
  it('is 1000ms', () => {
    expect(PREFETCH_STALE_TIME).toBe(1_000)
  })
})

describe('handlePrefetch', () => {
  it('calls prefetchQuery for /docker', async () => {
    handlePrefetch('/docker')
    expect(mockPrefetchQuery).toHaveBeenCalledTimes(1)
    const args = (mockPrefetchQuery.mock.calls[0] as unknown as [{ queryKey: string[]; staleTime: number }])[0]
    expect(args.queryKey).toEqual(['preload', 'docker-stats'])
    expect(args.staleTime).toBe(PREFETCH_STALE_TIME)
  })

  it('calls prefetchQuery for /zfs', () => {
    handlePrefetch('/zfs')
    expect(mockPrefetchQuery).toHaveBeenCalledTimes(1)
    const args = (mockPrefetchQuery.mock.calls[0] as unknown as [{ queryKey: string[]; staleTime: number }])[0]
    expect(args.queryKey).toEqual(['preload', 'zfs-stats'])
    expect(args.staleTime).toBe(PREFETCH_STALE_TIME)
  })

  it('calls prefetchQuery for /proxmox', () => {
    handlePrefetch('/proxmox')
    expect(mockPrefetchQuery).toHaveBeenCalledTimes(1)
    const args = (mockPrefetchQuery.mock.calls[0] as unknown as [{ queryKey: string[]; staleTime: number }])[0]
    expect(args.queryKey).toEqual(['preload', 'proxmox-stats'])
    expect(args.staleTime).toBe(PREFETCH_STALE_TIME)
  })

  it('calls prefetchQuery for /stacks', () => {
    handlePrefetch('/stacks')
    expect(mockPrefetchQuery).toHaveBeenCalledTimes(1)
    const args = (mockPrefetchQuery.mock.calls[0] as unknown as [{ queryKey: string[]; staleTime: number }])[0]
    expect(args.queryKey).toEqual(['stacks-list'])
    expect(args.staleTime).toBe(PREFETCH_STALE_TIME)
  })

  it('is a no-op for /settings', () => {
    handlePrefetch('/settings')
    expect(mockPrefetchQuery).not.toHaveBeenCalled()
  })

  it('swallows rejected promises from prefetchQuery', async () => {
    mockPrefetchQuery.mockImplementationOnce(() => Promise.reject(new Error('network error')))
    expect(() => handlePrefetch('/docker')).not.toThrow()
    let unhandledRejection = false
    const handler = () => { unhandledRejection = true }
    process.on('unhandledRejection', handler)
    handlePrefetch('/docker')
    // Flush the microtask queue thoroughly
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    process.off('unhandledRejection', handler)
    expect(unhandledRejection).toBe(false)
  })
})
