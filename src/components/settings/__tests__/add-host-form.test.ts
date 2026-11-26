import { describe, expect, it } from 'bun:test'
import {
  ADD_HOST_FORM_DEFAULTS,
  addHostFormSchema,
  firstContactAgentUrl,
  isAddHostStepValid,
  type AddHostFormValues,
} from '@/components/settings/add-host-form'
import { rotateHostTlsSchema } from '@/data/hosts/schemas'

function messagesFor(overrides: Partial<AddHostFormValues>): Record<string, string> {
  const result = addHostFormSchema.safeParse({ ...ADD_HOST_FORM_DEFAULTS, agentHost: '192.168.1.10', name: 'dev-box', ...overrides })
  if (result.success) return {}
  const messages: Record<string, string> = {}
  for (const issue of result.error.issues) messages[String(issue.path[0])] ??= issue.message
  return messages
}

describe('addHostFormSchema', () => {
  it('accepts a complete Docker host', () => {
    expect(messagesFor({})).toEqual({})
  })

  it.each([
    ['', 'Enter a name for this host.'],
    ['   ', 'Enter a name for this host.'],
    ['my host', 'Use only letters, numbers, hyphens and underscores. Spaces are not allowed.'],
    ['nas.local', 'Use only letters, numbers, hyphens and underscores. Spaces are not allowed.'],
    ['x'.repeat(101), 'Use 100 characters or fewer.'],
  ])('rejects the host name %p', (name, message) => {
    expect(messagesFor({ name })).toEqual({ name: message })
  })

  it('ignores spaces around an otherwise valid host name', () => {
    expect(messagesFor({ name: '  dev-box ' })).toEqual({})
  })

  it('asks for a capability when neither is selected', () => {
    expect(messagesFor({ docker: false, zfs: false })).toEqual({ zfs: 'Select at least one capability.' })
  })

  it('reports the capability rule even while the name is invalid', () => {
    expect(Object.keys(messagesFor({ name: 'my host', docker: false, zfs: false })).sort()).toEqual(['name', 'zfs'])
  })

  it('asks for the ZFS ids only when ZFS is selected', () => {
    expect(messagesFor({ zfs: true })).toEqual({
      hlmZfsUid: 'Enter the number after uid= in the command output.',
      hlmZfsGid: 'Enter the number after gid= for the zfs group.',
      dockerGid: 'Enter the numeric ID of the docker group.',
    })
    expect(messagesFor({ zfs: true, hlmZfsUid: '995', hlmZfsGid: '994', dockerGid: '999' })).toEqual({})
  })

  it('does not ask for the docker group id on a ZFS-only host', () => {
    expect(messagesFor({ docker: false, zfs: true, hlmZfsUid: '995', hlmZfsGid: '994' })).toEqual({})
  })

  it.each(['-5', '1.5', '1e3', 'abc'])('rejects the id %p', (value) => {
    expect(messagesFor({ zfs: true, hlmZfsUid: value, hlmZfsGid: '994', dockerGid: '999' })).toEqual({
      hlmZfsUid: 'Enter the number after uid= in the command output.',
    })
  })

  it.each([
    ['', 'Enter the host name or IP address of the agent.'],
    ['http://nas.local', 'Enter only a host name or IP address, without http:// or a port.'],
    ['nas.local:9090', 'Enter only a host name or IP address, without http:// or a port.'],
    ['my nas', 'Enter only a host name or IP address, without http:// or a port.'],
    ['256.256.256.256', 'This is not a valid host name or IP address.'],
    ['1.2.3.4.5', 'This is not a valid host name or IP address.'],
  ])('rejects the agent host %p', (agentHost, message) => {
    expect(messagesFor({ agentHost })).toEqual({ agentHost: message })
  })

  it.each(['nas.local', '192.168.1.10', '[fe80::1]'])('accepts the agent host %p', (agentHost) => {
    expect(messagesFor({ agentHost })).toEqual({})
  })

  it.each(['', '0', '65536', '9090.5', 'abc'])('rejects the port %p', (agentPort) => {
    expect(messagesFor({ agentPort })).toEqual({ agentPort: 'Enter a port from 1 to 65535.' })
  })

  it('judges the agent host the same whatever the port field holds', () => {
    expect(messagesFor({ agentHost: '256.256.256.256', agentPort: 'abc' }).agentHost).toBe('This is not a valid host name or IP address.')
  })

  it.each(['nas.local', '192.168.1.10', '[fe80::1]'])('composes a first-contact URL the server accepts for %p', (agentHost) => {
    const agentUrl = firstContactAgentUrl({ agentHost: ` ${agentHost} `, agentPort: ' 9090 ' })
    expect(agentUrl).toBe(`http://${agentHost}:9090`)
    expect(rotateHostTlsSchema.safeParse({ hostId: 1, agentUrl }).success).toBe(true)
  })
})

describe('isAddHostStepValid', () => {
  it('judges a step by its own fields only', () => {
    const values = { ...ADD_HOST_FORM_DEFAULTS, name: 'dev-box' }
    expect(isAddHostStepValid('Capabilities', values)).toBe(true)
    expect(isAddHostStepValid('Verify Connection', values)).toBe(false)
    expect(isAddHostStepValid('Capabilities', { ...values, name: 'my host' })).toBe(false)
  })

  it('treats a step with no fields as valid', () => {
    expect(isAddHostStepValid('Compose File', ADD_HOST_FORM_DEFAULTS)).toBe(true)
    expect(isAddHostStepValid('Configuration', ADD_HOST_FORM_DEFAULTS)).toBe(true)
  })

  it('needs every ZFS id on the ZFS step', () => {
    const values = { ...ADD_HOST_FORM_DEFAULTS, name: 'dev-box', zfs: true, hlmZfsUid: '995', hlmZfsGid: '994' }
    expect(isAddHostStepValid('ZFS Setup', values)).toBe(false)
    expect(isAddHostStepValid('ZFS Setup', { ...values, dockerGid: '999' })).toBe(true)
  })
})
