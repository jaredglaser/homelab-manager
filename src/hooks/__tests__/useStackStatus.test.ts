import { describe, it, expect, beforeEach, afterEach } from 'bun:test'

// Skip in CI due to React 19 + Happy-DOM compatibility issues
const isCI = process.env.CI === 'true'

if (isCI) {
  describe('useStackStatus', () => {
    it.skip('skipped in CI due to React 19 + Happy-DOM compatibility issue', () => {})
  })
} else {
  const { renderHook, act } = await import('@testing-library/react')
  const { MockEventSource } = await import('./test-utils/mock-event-source')
  const { useStackStatus } = await import('../useStackStatus')

  const originalEventSource = globalThis.EventSource

  beforeEach(() => {
    MockEventSource.reset()
    ;(globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource
  })

  afterEach(() => {
    ;(globalThis as unknown as Record<string, unknown>).EventSource = originalEventSource
  })

  describe('useStackStatus', () => {
    it('subscribes to /api/stack-status EventSource', () => {
      renderHook(() => useStackStatus())

      expect(MockEventSource.instances).toHaveLength(1)
      expect(MockEventSource.instances[0].url).toBe('/api/stack-status')
    })

    it('starts with empty statusMap and not connected', () => {
      const { result } = renderHook(() => useStackStatus())

      expect(result.current.statusMap.size).toBe(0)
      expect(result.current.isConnected).toBe(false)
      expect(result.current.error).toBeNull()
    })

    it('sets isConnected and clears error on open', () => {
      const { result } = renderHook(() => useStackStatus())

      act(() => {
        MockEventSource.instances[0].onopen?.()
      })

      expect(result.current.isConnected).toBe(true)
      expect(result.current.error).toBeNull()
    })

    it('parses SSE data into Map keyed by stack/host', () => {
      const { result } = renderHook(() => useStackStatus())
      const es = MockEventSource.instances[0]

      act(() => {
        es.onopen?.()
        es.onmessage?.({
          data: JSON.stringify([
            {
              stack: 'plex',
              host: 'server1',
              containers: [{ id: 'abc', name: 'plex', status: 'running', image: 'plexinc/pms-docker' }],
              updated_at: '2026-03-21T00:00:00Z',
            },
            {
              stack: 'traefik',
              host: 'server1',
              containers: [],
              updated_at: '2026-03-21T00:00:00Z',
            },
          ]),
        })
      })

      expect(result.current.statusMap.size).toBe(2)
      expect(result.current.statusMap.has('plex/server1')).toBe(true)
      expect(result.current.statusMap.has('traefik/server1')).toBe(true)
      expect(result.current.statusMap.get('plex/server1')?.containers).toHaveLength(1)
    })

    it('updates statusMap when new events arrive', () => {
      const { result } = renderHook(() => useStackStatus())
      const es = MockEventSource.instances[0]

      act(() => {
        es.onopen?.()
        es.onmessage?.({
          data: JSON.stringify([
            { stack: 'plex', host: 'server1', containers: [], updated_at: '2026-03-21T00:00:00Z' },
          ]),
        })
      })

      expect(result.current.statusMap.size).toBe(1)

      act(() => {
        es.onmessage?.({
          data: JSON.stringify([
            { stack: 'plex', host: 'server1', containers: [], updated_at: '2026-03-21T00:00:01Z' },
            { stack: 'traefik', host: 'server1', containers: [], updated_at: '2026-03-21T00:00:01Z' },
          ]),
        })
      })

      expect(result.current.statusMap.size).toBe(2)
      expect(result.current.statusMap.has('traefik/server1')).toBe(true)
    })

    it('handles connection errors by setting isConnected=false and error', () => {
      const { result } = renderHook(() => useStackStatus())
      const es = MockEventSource.instances[0]

      act(() => {
        es.onopen?.()
      })
      expect(result.current.isConnected).toBe(true)

      act(() => {
        es.onerror?.()
      })

      expect(result.current.isConnected).toBe(false)
      expect(result.current.error).toBe('Connection lost')
    })

    it('cleans up EventSource on unmount', () => {
      const { unmount } = renderHook(() => useStackStatus())
      const es = MockEventSource.instances[0]

      expect(es.closed).toBe(false)

      unmount()

      expect(es.closed).toBe(true)
    })

    it('skips malformed SSE events without throwing', () => {
      const { result } = renderHook(() => useStackStatus())
      const es = MockEventSource.instances[0]

      act(() => {
        es.onopen?.()
        es.onmessage?.({ data: 'not valid json {{{' })
      })

      // Should remain unchanged — no crash
      expect(result.current.statusMap.size).toBe(0)
      expect(result.current.isConnected).toBe(true)
    })

    it('uses stack/host composite key correctly for multiple hosts', () => {
      const { result } = renderHook(() => useStackStatus())
      const es = MockEventSource.instances[0]

      act(() => {
        es.onopen?.()
        es.onmessage?.({
          data: JSON.stringify([
            { stack: 'plex', host: 'server1', containers: [], updated_at: '2026-03-21T00:00:00Z' },
            { stack: 'plex', host: 'server2', containers: [], updated_at: '2026-03-21T00:00:00Z' },
          ]),
        })
      })

      expect(result.current.statusMap.size).toBe(2)
      expect(result.current.statusMap.has('plex/server1')).toBe(true)
      expect(result.current.statusMap.has('plex/server2')).toBe(true)
    })
  })
}
