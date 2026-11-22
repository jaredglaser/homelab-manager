import { describe, it, expect } from 'bun:test'
import { listHosts, updateHost } from '@/lib/mock/functions/hosts.functions'

describe('mock updateHost', () => {
  it('keeps the stored host and applies the edited URL', async () => {
    const [, stored] = await listHosts()
    const updated = await updateHost({ hostId: stored.id, name: stored.name, agentUrl: 'http://10.0.0.9:9090' })
    expect(updated).toEqual({ ...stored, agentUrl: 'http://10.0.0.9:9090', updatedAt: updated.updatedAt })
    expect(updated.capabilities).toEqual({ docker: true, zfs: true })
    expect(updated.createdAt).toBe(stored.createdAt)
  })

  it('does not change what listHosts serves', async () => {
    const [first] = await listHosts()
    await updateHost({ hostId: first.id, name: first.name, agentUrl: 'http://10.0.0.9:9090' })
    expect((await listHosts())[0].agentUrl).toBe(first.agentUrl)
  })

  it('builds a host for an id that is not in the fixed set', async () => {
    const built = await updateHost({ hostId: 999, name: 'new', agentUrl: 'http://10.0.0.8:9090' })
    expect(built).toMatchObject({ id: 999, name: 'new', agentUrl: 'http://10.0.0.8:9090' })
  })
})
