import { describe, expect, it, mock } from 'bun:test'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ZfsNodeSummary } from '@/lib/zfs/node-state'

const node = (name: string, state: ZfsNodeSummary['state']): ZfsNodeSummary => ({
  id: name.length,
  name,
  address: `${name}.lan`,
  port: 2222,
  allowedFrom: null,
  state,
  hostKeyFingerprint: 'SHA256:k',
  seenHostKeyFingerprint: null,
  lastSuccessAt: null,
})

mock.module('@/data/zfs/functions', () => ({
  listZfsNodes: () => Promise.resolve([node('pve1', 'ok'), node('pve2', 'unreachable'), node('pve3', 'influxdb_missing')]),
}))

describe('useZfsNodeNotices', () => {
  it('maps each node that is not collecting normally to its notice, by name', async () => {
    const { useZfsNodeNotices } = await import('@/hooks/useZfsNodes')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const { result } = renderHook(() => useZfsNodeNotices(), { wrapper })
    await waitFor(() => expect(result.current.size).toBe(2))
    expect([...result.current.entries()]).toEqual([
      ['pve2', "Can't reach pve2 over SSH on port 2222."],
      ['pve3', 'pve3 is missing zpool_influxdb, which comes with ZFS. Update the zfsutils-linux package on the node.'],
    ])
  })
})
