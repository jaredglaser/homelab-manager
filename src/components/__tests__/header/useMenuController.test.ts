import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { renderHook, act } from '@testing-library/react'

let mockPathname = '/docker'

mock.module('@tanstack/react-router', () => ({
  useLocation: ({ select }: { select: (l: { pathname: string }) => string }) =>
    select({ pathname: mockPathname }),
}))

mock.module('@/components/AppShell', () => ({
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

const { useMenuController, useCurrentTab } = await import('../../header/useMenuController')

describe('useMenuController', () => {
  let originalSetTimeout: typeof globalThis.setTimeout
  let originalClearTimeout: typeof globalThis.clearTimeout
  let pendingCallbacks: Array<{ fn: () => void; id: number }> = []
  let nextTimerId = 1

  beforeEach(() => {
    originalSetTimeout = globalThis.setTimeout
    originalClearTimeout = globalThis.clearTimeout
    pendingCallbacks = []
    nextTimerId = 1

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).setTimeout = (fn: () => void, _delay?: number) => {
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
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    pendingCallbacks = []
  })

  function flushTimers() {
    const cbs = [...pendingCallbacks]
    pendingCallbacks = []
    for (const cb of cbs) cb.fn()
  }

  it('starts with openId === null', () => {
    const { result } = renderHook(() => useMenuController())
    expect(result.current.openId).toBeNull()
  })

  it('requestOpen sets openId synchronously', () => {
    const { result } = renderHook(() => useMenuController())
    act(() => {
      result.current.requestOpen('/docker')
    })
    expect(result.current.openId).toBe('/docker')
  })

  it('requestClose clears openId after MENU_CLOSE_DELAY_MS', () => {
    const { result } = renderHook(() => useMenuController())
    act(() => {
      result.current.requestOpen('/docker')
    })
    act(() => {
      result.current.requestClose()
    })
    expect(result.current.openId).toBe('/docker')
    act(() => {
      flushTimers()
    })
    expect(result.current.openId).toBeNull()
  })

  it('requestOpen after requestClose cancels the pending close', () => {
    const { result } = renderHook(() => useMenuController())
    act(() => {
      result.current.requestOpen('/docker')
    })
    act(() => {
      result.current.requestClose()
    })
    act(() => {
      result.current.requestOpen('/stacks')
    })
    act(() => {
      flushTimers()
    })
    // timer was cancelled so openId stays as the new value
    expect(result.current.openId).toBe('/stacks')
  })

  it('closeNow clears openId immediately', () => {
    const { result } = renderHook(() => useMenuController())
    act(() => {
      result.current.requestOpen('/settings')
    })
    act(() => {
      result.current.closeNow()
    })
    expect(result.current.openId).toBeNull()
  })

  it('unmount cancels pending timer without error', () => {
    const { result, unmount } = renderHook(() => useMenuController())
    act(() => {
      result.current.requestOpen('/docker')
    })
    act(() => {
      result.current.requestClose()
    })
    expect(() => unmount()).not.toThrow()
  })
})

describe('useCurrentTab', () => {
  beforeEach(() => {
    mockPathname = '/docker'
  })

  it('returns /docker for /docker path', () => {
    mockPathname = '/docker'
    const { result } = renderHook(() => useCurrentTab())
    expect(result.current).toBe('/docker')
  })

  it('returns /stacks for /stacks/foo path', () => {
    mockPathname = '/stacks/foo'
    const { result } = renderHook(() => useCurrentTab())
    expect(result.current).toBe('/stacks')
  })

  it('defaults to /docker for unknown paths like /', () => {
    mockPathname = '/'
    const { result } = renderHook(() => useCurrentTab())
    expect(result.current).toBe('/docker')
  })

  it('returns /settings for /settings path', () => {
    mockPathname = '/settings'
    const { result } = renderHook(() => useCurrentTab())
    expect(result.current).toBe('/settings')
  })

  it('returns /zfs for /zfs path', () => {
    mockPathname = '/zfs'
    const { result } = renderHook(() => useCurrentTab())
    expect(result.current).toBe('/zfs')
  })
})
