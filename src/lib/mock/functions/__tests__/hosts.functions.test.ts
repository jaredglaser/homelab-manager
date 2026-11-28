import { describe, it, expect, afterEach } from 'bun:test'
import {
  MOCK_AGENT_UPDATE_MS,
  listAgentsInventory,
  listHosts,
  resetMockAgentUpdates,
  updateAgent,
  updateHost,
} from '@/lib/mock/functions/hosts.functions'
import { agentInventoryUpdates } from '@/lib/mock/live-updates'
import { mockSetTimeout } from '@/lib/test/mock-timers'
import type { AgentInventoryMessage } from '@/lib/channels/agent-inventory'

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

describe('mock updateAgent', () => {
  afterEach(() => resetMockAgentUpdates())

  it('starts the update at once, shows it running, then publishes the success after a moment', async () => {
    const timers = mockSetTimeout()
    let off = () => {}
    const publishedDone = new Promise<AgentInventoryMessage>((resolve) => {
      off = agentInventoryUpdates.on((message) => {
        if (message.entries[0].update?.state === 'done') resolve(message)
      })
    })
    try {
      const [host] = await listAgentsInventory()
      const answer = await updateAgent({ hostId: host.id })
      expect(answer).toMatchObject({ hostId: host.id, healthy: true, outcome: 'started' })
      expect(timers.delays).toEqual([MOCK_AGENT_UPDATE_MS])
      expect((await listAgentsInventory())[0].update).toEqual({ state: 'running', at: answer.at })

      timers.fireNext()
      const [after] = await listAgentsInventory()
      expect(after.update).toMatchObject({ state: 'done', result: { healthy: true, outcome: 'updated', version: '0.1.0' } })
      expect((await publishedDone).entries[0].update).toEqual(after.update)
    } finally {
      off()
      timers.restore()
    }
  })

  it('refuses a second update while one runs', async () => {
    const timers = mockSetTimeout()
    try {
      const [host] = await listAgentsInventory()
      await updateAgent({ hostId: host.id })
      expect(await updateAgent({ hostId: host.id })).toMatchObject({ healthy: false, code: 'update_already_running', message: '' })
      expect(timers.delays).toHaveLength(1)
    } finally {
      timers.restore()
    }
  })
})
