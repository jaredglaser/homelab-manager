import { describe, it, expect } from 'bun:test'
import { agentTagTooltip } from '@/components/settings/HostRow'
import type { HostListItem } from '@/lib/hosts/host-utils'

const makeHost = (overrides?: Partial<HostListItem>): HostListItem => ({
  id: 1,
  name: 'server1',
  agentUrl: 'http://192.168.1.10:9090',
  capabilities: { docker: true },
  agentVersion: '1.2.3',
  agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent:latest',
  agentImageTag: 'latest',
  sshHost: null,
  sshUser: null,
  status: 'healthy',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
})

describe('agentTagTooltip', () => {
  it('shows just the image when the host is on channel', () => {
    expect(agentTagTooltip(makeHost(), 'latest')).toBe('ghcr.io/jaredglaser/homelab-manager-agent:latest')
  })

  it('explains the mismatch when the host is off channel', () => {
    const host = makeHost({ agentImage: 'ghcr.io/x/agent:dev', agentImageTag: 'dev' })
    expect(agentTagTooltip(host, 'latest')).toBe(
      "ghcr.io/x/agent:dev does not match this dashboard's latest channel",
    )
  })

  it('names the dashboard channel it compared against', () => {
    const host = makeHost({ agentImage: 'ghcr.io/x/agent:latest', agentImageTag: 'latest' })
    expect(agentTagTooltip(host, 'dev')).toContain("dashboard's dev channel")
  })

  it('falls back to the tag when only the tag is known', () => {
    const host = makeHost({ agentImage: null, agentImageTag: 'dev' })
    expect(agentTagTooltip(host, 'dev')).toBe('dev')
  })
})
