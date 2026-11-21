import { describe, it, expect, mock, beforeEach, spyOn } from 'bun:test'
import { render, screen, waitFor, act } from '@testing-library/react'
import { setupUser, type TestUser } from '@/lib/test/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { mockModule } from '@/lib/test/mock-module'
// Registers RTL auto-cleanup: without it, earlier tests' renders stay mounted and
// screen.* queries and clicks leak into whichever wizard was mounted first.
import '@/lib/test/testing-library'
import type { HostListItem } from '@/lib/hosts/host-utils'
import type { HealthCheckResult } from '@/data/hosts/handlers'
import type { TlsFailureCode } from '@homelab-manager/agent/types'

// Register module mocks before any component import: a mock.module call made
// after the module graph has loaded leaves it wired to the real server fns.
const toasts: Array<{ message: string; severity?: string }> = []

mockModule<typeof import('@/hooks/toastAtom')>('@/hooks/toastAtom', (real) => ({
  ...real,
  useToast: () => ({
    showToast: (message: string, severity?: string) => {
      toasts.push({ message, severity })
    },
  }),
}))

const makeHost = (overrides?: Partial<HostListItem>): HostListItem => ({
  id: 1,
  name: 'server1',
  agentUrl: 'http://192.168.1.10:9090',
  capabilities: { docker: true, zfs: false },
  agentVersion: '1.2.3',
  agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent:latest',
  agentImageTag: 'latest',
  status: 'healthy',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
})

// The rotate flow returns its failures as data now, so a failure is a resolved result, not a throw.
type RotateTlsResult =
  | { ok: true; hostId: number; agentUrl: string; enrolledOverPlainHttp?: boolean }
  | { ok: false; code: TlsFailureCode; message: string }
let rotateTlsResult: Promise<RotateTlsResult> = Promise.resolve({ ok: true, hostId: 1, agentUrl: 'https://server1:9090' })
let rotateTlsCalls: Array<{ data: { hostId: number; agentUrl?: string; acceptPlaintextEnrollment?: boolean } }> = []
// When set, rotateHostTls returns this manually-settled promise instead.
let rotateTlsGate: Promise<RotateTlsResult> | null = null

const rotateHostTls = (data: {
  data: { hostId: number; agentUrl?: string; acceptPlaintextEnrollment?: boolean }
}): Promise<RotateTlsResult> => {
  rotateTlsCalls.push(data)
  return rotateTlsGate ?? rotateTlsResult
}

type CreatePendingHostResult = { host: HostListItem; publicJwk: Record<string, string> }
let createPendingHostResult: Promise<CreatePendingHostResult> = Promise.resolve({
  host: makeHost({ status: 'pending' }),
  publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'wizard-key-x' },
})
let createPendingHostCalls: Array<{ name: string }> = []

// What listHosts serves. Creating a pending host lands its row in this list with
// the response status, like the real server, so the card's live-status checks see it.
let hostsRows: HostListItem[] = [makeHost()]
let listHostsGate: Promise<HostListItem[]> | null = null
const listHosts = (): Promise<HostListItem[]> => listHostsGate ?? Promise.resolve(hostsRows)

const createPendingHost = (data: { data: { name: string; capabilities?: { docker?: boolean; zfs?: boolean } } }): Promise<CreatePendingHostResult> => {
  createPendingHostCalls.push({ name: data.data.name })
  return createPendingHostResult.then((res) => {
    hostsRows = hostsRows.map((h) => (h.id === res.host.id ? res.host : h))
    return res
  })
}

// Production falls back to fixed copy when a rejection is not an Error, so the tests must be able to reject with one.
const rejectWith = (reason: unknown): Promise<never> =>
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
  Promise.reject(reason)

let removeHostCalls: number[] = []
let removeHostData: Array<{ hostId: number; expectStatus?: 'pending' }> = []
// When set, removeHost rejects with this error instead of resolving.
let removeHostError: unknown = null
const removeHost = (data: { data: { hostId: number; expectStatus?: 'pending' } }): Promise<{ success: boolean }> => {
  removeHostCalls.push(data.data.hostId)
  removeHostData.push(data.data)
  if (removeHostError != null) return rejectWith(removeHostError)
  return Promise.resolve({ success: true })
}

let updateHostCalls: Array<{ hostId: number; agentUrl?: string }> = []
let updateHostError: unknown = null
let updateHostGate: Promise<HostListItem> | null = null
const updateHost = (data: { data: { hostId: number; agentUrl?: string } }): Promise<HostListItem> => {
  updateHostCalls.push({ hostId: data.data.hostId, agentUrl: data.data.agentUrl })
  if (updateHostError != null) return rejectWith(updateHostError)
  const row = hostsRows.find((h) => h.id === data.data.hostId) ?? makeHost()
  return updateHostGate ?? Promise.resolve({ ...row, agentUrl: data.data.agentUrl ?? row.agentUrl })
}

const healthCheckCalls: number[] = []
let healthCheckResult: Promise<HealthCheckResult> = Promise.resolve({ hostId: 1, healthy: true })

const keypairCalls: Array<{ op: 'view' | 'rotate'; hostId: number }> = []
let keypairError: unknown = null
const getHostPublicJwk = (data: { data: { hostId: number } }): Promise<{ publicJwk: Record<string, string>; fingerprint: string }> => {
  keypairCalls.push({ op: 'view', hostId: data.data.hostId })
  if (keypairError != null) return rejectWith(keypairError)
  return Promise.resolve({ publicJwk: { kty: 'OKP', x: 'viewed-key' }, fingerprint: 'AB:CD:EF' })
}
const rotateHostKeypair = (data: { data: { hostId: number } }): Promise<{ hostId: number; publicJwk: Record<string, string> }> => {
  keypairCalls.push({ op: 'rotate', hostId: data.data.hostId })
  if (keypairError != null) return rejectWith(keypairError)
  return Promise.resolve({ hostId: data.data.hostId, publicJwk: { kty: 'OKP', x: 'rotated-key' } })
}

mock.module('@/data/hosts/functions', () => ({
  listHosts,
  createPendingHost,
  removeHost,
  checkHostHealth: (data: { data: { hostId: number } }) => {
    healthCheckCalls.push(data.data.hostId)
    return healthCheckResult
  },
  updateHost,
  getHostPublicJwk: (data: { data: { hostId: number } }) => getHostPublicJwk(data),
  rotateHostKeypair: (data: { data: { hostId: number } }) => rotateHostKeypair(data),
  rotateHostTls: (data: { data: { hostId: number; agentUrl?: string; acceptPlaintextEnrollment?: boolean } }) =>
    rotateHostTls(data),
}))

let lastQueryClient: QueryClient | null = null

function renderCard(props: { filterHostName?: string } = {}): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  lastQueryClient = queryClient
  const { ManagedHostsCard } = require('@/components/settings/ManagedHostsCardConnected') as typeof import('@/components/settings/ManagedHostsCardConnected')
  render(
    <QueryClientProvider client={queryClient}>
      <ManagedHostsCard {...props} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  rotateTlsGate = null
  rotateTlsCalls.length = 0
  removeHostCalls.length = 0
  removeHostData.length = 0
  removeHostError = null
  updateHostError = null
  updateHostGate = null
  listHostsGate = null
  keypairError = null
  keypairCalls.length = 0
  healthCheckCalls.length = 0
  updateHostCalls.length = 0
  createPendingHostCalls.length = 0
  toasts.length = 0
  hostsRows = [makeHost()]
  rotateTlsResult = Promise.resolve({ ok: true, hostId: 1, agentUrl: 'https://server1:9090' })
  createPendingHostResult = Promise.resolve({
    host: makeHost({ status: 'pending' }),
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'wizard-key-x' },
  })
  healthCheckResult = Promise.resolve({ hostId: 1, healthy: true })
})

describe('ManagedHostsCardConnected rotate TLS toasts', () => {
  it('shows the pinned success toast after a successful rotation', async () => {
    const user = setupUser()
    renderCard()
    await screen.findByText('server1')
    rotateTlsResult = Promise.resolve({ ok: true, hostId: 1, agentUrl: 'https://server1:9090' })

    await user.click(screen.getByLabelText('rotate TLS'))

    await waitFor(() => {
      expect(
        toasts.some((t) => t.message === 'TLS certificate rotated for https://server1:9090. The agent is now serving the new certificate.'),
      ).toBe(true)
    })
    expect(rotateTlsCalls).toEqual([{ data: { hostId: 1 } }])
  })

  it('shows the pinned fallback toast when rotation fails without an Error', async () => {
    const user = setupUser()
    renderCard()
    await screen.findByText('server1')
    rotateTlsResult = rejectWith('boom')
    // The rejection stays unconsumed until the click dispatches the mutation, and bun fails the test on the unhandled rejection, so attach a no-op consumer up front.
    rotateTlsResult.catch(() => null)

    await user.click(screen.getByLabelText('rotate TLS'))

    await waitFor(() => {
      expect(toasts.some((t) => t.message === 'Failed to rotate the TLS certificate')).toBe(true)
    })
  })
})

describe('ManagedHostsCardConnected health check toasts', () => {
  it('maps an unhealthy result to its code copy', async () => {
    const user = setupUser()
    healthCheckResult = Promise.resolve({
      hostId: 1,
      healthy: false,
      code: 'awaiting-enrollment',
      message: 'The agent is serving plain HTTP awaiting TLS enrollment, so the manager cannot verify it over https.',
    })
    renderCard()
    await screen.findByText('server1')

    await user.click(screen.getByLabelText('check health'))

    await waitFor(() => {
      expect(toasts).toEqual([
        {
          message: 'The agent is serving plain HTTP because it holds no certificate yet. Enroll a certificate for this host, then check again.',
          severity: 'error',
        },
      ])
    })
  })
})

describe('ManagedHostsCardConnected row actions', () => {
  const rotateButton = () => screen.getByLabelText<HTMLButtonElement>('rotate TLS')

  it('lists only the filtered host when filterHostName is set', async () => {
    hostsRows = [makeHost({ id: 1, name: 'server1' }), makeHost({ id: 2, name: 'server2' })]
    renderCard({ filterHostName: 'server2' })
    await screen.findByText('server2')
    expect(screen.queryAllByText('server1').length).toBe(0)
  })

  it('lists every host when filterHostName is not set', async () => {
    hostsRows = [makeHost({ id: 1, name: 'server1' }), makeHost({ id: 2, name: 'server2' })]
    renderCard()
    await screen.findByText('server2')
    expect(screen.getByText('server1')).toBeDefined()
  })

  describe('health check toasts', () => {
    it('reports a healthy host with its version', async () => {
      const user = setupUser()
      healthCheckResult = Promise.resolve({ hostId: 1, healthy: true, version: '1.2.3' })
      renderCard()
      await screen.findByText('server1')
      await user.click(screen.getByLabelText('check health'))
      await waitFor(() => {
        expect(toasts).toEqual([{ message: 'Host is healthy (v1.2.3)', severity: 'success' }])
      })
    })

    it('reports a healthy host without a version', async () => {
      const user = setupUser()
      renderCard()
      await screen.findByText('server1')
      await user.click(screen.getByLabelText('check health'))
      await waitFor(() => {
        expect(toasts).toEqual([{ message: 'Host is healthy', severity: 'success' }])
      })
    })

    it('shows the error message when the check itself fails', async () => {
      const user = setupUser()
      healthCheckResult = Promise.reject(new Error('socket hang up'))
      healthCheckResult.catch(() => null)
      renderCard()
      await screen.findByText('server1')
      await user.click(screen.getByLabelText('check health'))
      await waitFor(() => {
        expect(toasts).toEqual([{ message: 'socket hang up', severity: 'error' }])
      })
      expect(screen.getByLabelText<HTMLButtonElement>('check health').disabled).toBe(false)
    })

    it('falls back to a plain message when the check fails without an Error', async () => {
      const user = setupUser()
      healthCheckResult = rejectWith('boom')
      healthCheckResult.catch(() => null)
      renderCard()
      await screen.findByText('server1')
      await user.click(screen.getByLabelText('check health'))
      await waitFor(() => {
        expect(toasts).toEqual([{ message: 'Health check failed', severity: 'error' }])
      })
    })
  })

  describe('rotate TLS', () => {
    it('shows the row as rotating until the rotation succeeds', async () => {
      const user = setupUser()
      let resolveRotate!: (result: RotateTlsResult) => void
      rotateTlsGate = new Promise<RotateTlsResult>((res) => { resolveRotate = res })
      renderCard()
      await screen.findByText('server1')
      await user.click(rotateButton())
      await waitFor(() => expect(rotateButton().disabled).toBe(true))
      resolveRotate({ ok: true, hostId: 1, agentUrl: 'https://server1:9090' })
      await waitFor(() => expect(rotateButton().disabled).toBe(false))
    })

    it('clears the rotating state and shows the error when the rotation throws', async () => {
      const user = setupUser()
      let rejectRotate!: (reason: unknown) => void
      rotateTlsGate = new Promise<RotateTlsResult>((_res, rej) => { rejectRotate = rej })
      rotateTlsGate.catch(() => null)
      renderCard()
      await screen.findByText('server1')
      await user.click(rotateButton())
      await waitFor(() => expect(rotateButton().disabled).toBe(true))
      rejectRotate(new Error('Session expired'))
      await waitFor(() => expect(rotateButton().disabled).toBe(false))
      expect(toasts).toEqual([{ message: 'Session expired', severity: 'error' }])
    })

    it('clears the rotating state and offers a retry when the agent could not be reached', async () => {
      const user = setupUser()
      rotateTlsResult = Promise.resolve({ ok: false, code: 'agent_unreachable', message: 'ECONNREFUSED' })
      renderCard()
      await screen.findByText('server1')
      await user.click(rotateButton())
      await waitFor(() => {
        expect(toasts).toEqual([
          {
            message:
              "The agent could not be reached. Check that its container is running and listening on the URL stored for this host, then retry. An agent that already enrolled and restarted serving HTTPS only looks the same from here. Use Rotate TLS on this host's row to try again.",
            severity: 'error',
          },
        ])
      })
      expect(rotateButton().disabled).toBe(false)
    })

    it('does not offer a retry when running the rotation again cannot help', async () => {
      const user = setupUser()
      rotateTlsResult = Promise.resolve({ ok: false, code: 'pin_missing', message: 'no pin' })
      renderCard()
      await screen.findByText('server1')
      await user.click(rotateButton())
      await waitFor(() => {
        expect(toasts).toEqual([
          {
            message:
              'The manager has no pinned certificate for this host, and the enrollment could not be completed. If the agent is running, remove its certificate files on the agent host, restart it, then enroll a certificate for this host from its row in the Managed Hosts card.',
            severity: 'error',
          },
        ])
      })
    })
  })

  describe('remove and update toasts', () => {
    async function confirmRemoval(user: TestUser) {
      renderCard()
      await screen.findByText('server1')
      await user.click(screen.getByLabelText('remove host'))
      await user.click(screen.getByRole('button', { name: 'Remove' }))
    }

    it('removes the host and confirms it', async () => {
      const user = setupUser()
      await confirmRemoval(user)
      await waitFor(() => {
        expect(toasts).toEqual([{ message: 'Host removed', severity: 'success' }])
      })
      expect(removeHostData).toEqual([{ hostId: 1 }])
      await waitFor(() => expect(screen.queryAllByRole('dialog').length).toBe(0))
    })

    it('shows the server message when the removal fails', async () => {
      const user = setupUser()
      removeHostError = new Error('Host is still referenced by a deploy')
      await confirmRemoval(user)
      await waitFor(() => {
        expect(toasts).toEqual([{ message: 'Host is still referenced by a deploy', severity: 'error' }])
      })
    })

    it('falls back to a plain message when the removal fails without an Error', async () => {
      const user = setupUser()
      removeHostError = 'boom'
      await confirmRemoval(user)
      await waitFor(() => {
        expect(toasts).toEqual([{ message: 'Failed to remove host', severity: 'error' }])
      })
    })

    async function saveEdit(user: TestUser) {
      renderCard()
      await screen.findByText('server1')
      await user.click(screen.getByLabelText('edit host'))
      await user.clear(screen.getByLabelText('Edit Agent URL'))
      await user.type(screen.getByLabelText('Edit Agent URL'), 'http://10.0.0.9:9090')
      await user.click(screen.getByRole('button', { name: 'Save' }))
    }

    it('saves the edited URL and confirms it', async () => {
      const user = setupUser()
      await saveEdit(user)
      await waitFor(() => {
        expect(toasts).toEqual([{ message: 'Host updated', severity: 'success' }])
      })
      expect(updateHostCalls).toEqual([{ hostId: 1, agentUrl: 'http://10.0.0.9:9090' }])
    })

    it('shows the server message when the update fails', async () => {
      const user = setupUser()
      updateHostError = new Error('Agent URL is not reachable')
      await saveEdit(user)
      await waitFor(() => {
        expect(toasts).toEqual([{ message: 'Agent URL is not reachable', severity: 'error' }])
      })
    })

    it('falls back to a plain message when the update fails without an Error', async () => {
      const user = setupUser()
      updateHostError = 'boom'
      await saveEdit(user)
      await waitFor(() => {
        expect(toasts).toEqual([{ message: 'Failed to update host', severity: 'error' }])
      })
    })

    it('closes the edit dialog after the update succeeds', async () => {
      const user = setupUser()
      await saveEdit(user)
      await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0))
      expect(toasts).toEqual([{ message: 'Host updated', severity: 'success' }])
      expect(updateHostCalls).toHaveLength(1)
    })

    it('keeps the edit dialog open with the edited URL when the update fails, and a retry saves again', async () => {
      const user = setupUser()
      updateHostError = new Error('Agent URL is not reachable')
      await saveEdit(user)
      await waitFor(() => expect(toasts).toHaveLength(1))
      expect(screen.getAllByRole('dialog')).toHaveLength(1)
      expect(screen.getByLabelText<HTMLInputElement>('Edit Agent URL').value).toBe('http://10.0.0.9:9090')
      await waitFor(() => expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false))
      updateHostError = null
      await user.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0))
      expect(updateHostCalls).toEqual([
        { hostId: 1, agentUrl: 'http://10.0.0.9:9090' },
        { hostId: 1, agentUrl: 'http://10.0.0.9:9090' },
      ])
    })

    it('sends one update when Save is double-clicked', async () => {
      const user = setupUser()
      renderCard()
      await screen.findByText('server1')
      await user.click(screen.getByLabelText('edit host'))
      await user.dblClick(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0))
      expect(updateHostCalls).toHaveLength(1)
      expect(toasts).toEqual([{ message: 'Host updated', severity: 'success' }])
    })

    it('reopens with the saved URL while the list refetch is still pending', async () => {
      const user = setupUser()
      renderCard()
      await screen.findByText('server1')
      listHostsGate = new Promise<HostListItem[]>(() => undefined)
      await user.click(screen.getByLabelText('edit host'))
      await user.clear(screen.getByLabelText('Edit Agent URL'))
      await user.type(screen.getByLabelText('Edit Agent URL'), 'http://10.0.0.9:9090')
      await user.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0))
      await user.click(screen.getByLabelText('edit host'))
      expect(screen.getByLabelText<HTMLInputElement>('Edit Agent URL').value).toBe('http://10.0.0.9:9090')
    })

    it('still shows the failure toast and opens nothing when the update fails after the dialog was dismissed', async () => {
      const user = setupUser()
      let rejectUpdate: (reason: Error) => void = () => undefined
      updateHostGate = new Promise<HostListItem>((_res, rej) => { rejectUpdate = rej })
      updateHostGate.catch(() => null)
      await saveEdit(user)
      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0))
      await act(() => Promise.resolve(rejectUpdate(new Error('Agent URL is not reachable'))))
      await waitFor(() => expect(toasts).toEqual([{ message: 'Agent URL is not reachable', severity: 'error' }]))
      expect(screen.queryAllByRole('dialog')).toHaveLength(0)
      updateHostGate = null
      await user.click(screen.getByLabelText('edit host'))
      await user.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0))
      expect(updateHostCalls).toHaveLength(2)
      expect(toasts).toEqual([
        { message: 'Agent URL is not reachable', severity: 'error' },
        { message: 'Host updated', severity: 'success' },
      ])
    })

    it('leaves another host\'s edit dialog open when the first save succeeds after the switch', async () => {
      const user = setupUser()
      hostsRows = [makeHost({ id: 1, name: 'server1' }), makeHost({ id: 2, name: 'server2' })]
      let resolveUpdate: (host: HostListItem) => void = () => undefined
      updateHostGate = new Promise<HostListItem>((res) => { resolveUpdate = res })
      renderCard()
      await screen.findByText('server2')
      await user.click(screen.getAllByLabelText('edit host')[0])
      await user.click(screen.getByRole('button', { name: 'Save' }))
      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0))
      await user.click(screen.getAllByLabelText('edit host')[1])
      await act(() => Promise.resolve(resolveUpdate(makeHost())))
      await waitFor(() => expect(toasts).toEqual([{ message: 'Host updated', severity: 'success' }]))
      expect(screen.getAllByRole('dialog')).toHaveLength(1)
      expect(screen.getByLabelText<HTMLInputElement>('Edit Host Name').value).toBe('server2')
    })
  })

  it('acts on the clicked host when several are listed', async () => {
    const user = setupUser()
    hostsRows = [makeHost({ id: 1, name: 'server1' }), makeHost({ id: 2, name: 'server2' })]
    renderCard()
    await screen.findByText('server2')

    await user.click(screen.getAllByLabelText('check health')[1])
    await waitFor(() => expect(healthCheckCalls).toEqual([2]))

    await user.click(screen.getAllByLabelText('rotate TLS')[1])
    await waitFor(() => expect(rotateTlsCalls).toEqual([{ data: { hostId: 2 } }]))

    await user.click(screen.getAllByLabelText('agent keypair')[1])
    await user.click(await screen.findByRole('button', { name: 'Rotate keypair' }))
    await user.click(screen.getByRole('button', { name: 'Confirm rotation' }))
    await waitFor(() => expect(keypairCalls).toEqual([{ op: 'view', hostId: 2 }, { op: 'rotate', hostId: 2 }]))
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryAllByRole('dialog').length).toBe(0))

    await user.click(screen.getAllByLabelText('remove host')[1])
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(removeHostData).toEqual([{ hostId: 2 }]))
    await waitFor(() => expect(screen.queryAllByRole('dialog').length).toBe(0))

    await user.click(screen.getAllByLabelText('edit host')[1])
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updateHostCalls).toEqual([{ hostId: 2, agentUrl: 'http://192.168.1.10:9090' }]))
  })

  describe('keypair dialog', () => {
    async function openKeypairDialog(user: TestUser) {
      renderCard()
      await screen.findByText('server1')
      await user.click(screen.getByLabelText('agent keypair'))
    }

    it('loads the key and shows it with the pinned fingerprint', async () => {
      const user = setupUser()
      await openKeypairDialog(user)
      await waitFor(() => {
        expect(screen.getByTestId('host-pubkey-display').textContent).toBe('{"kty":"OKP","x":"viewed-key"}')
      })
      expect(screen.getByTestId('host-fingerprint-display').textContent).toBe('AB:CD:EF')
      expect(keypairCalls).toEqual([{ op: 'view', hostId: 1 }])
    })

    it('shows the server message and no key when loading fails', async () => {
      const user = setupUser()
      keypairError = new Error('Keypair store unavailable')
      await openKeypairDialog(user)
      await waitFor(() => {
        expect(toasts).toEqual([{ message: 'Keypair store unavailable', severity: 'error' }])
      })
      expect(screen.getByText('No keypair is stored for this host yet.')).toBeDefined()
    })

    it('falls back to a plain message when loading fails without an Error', async () => {
      const user = setupUser()
      keypairError = 'boom'
      await openKeypairDialog(user)
      await waitFor(() => {
        expect(toasts).toEqual([{ message: 'Failed to load keypair', severity: 'error' }])
      })
    })

    it('rotates the key after confirmation and warns that the agent must be updated', async () => {
      const user = setupUser()
      await openKeypairDialog(user)
      await user.click(await screen.findByRole('button', { name: 'Rotate keypair' }))
      await user.click(screen.getByRole('button', { name: 'Confirm rotation' }))
      await waitFor(() => {
        expect(toasts).toEqual([
          { message: 'Keypair rotated. Update AGENT_TRUSTED_PUBKEY on the agent and restart it.', severity: 'warning' },
        ])
      })
      expect(keypairCalls).toEqual([{ op: 'view', hostId: 1 }, { op: 'rotate', hostId: 1 }])
      await waitFor(() => {
        expect(screen.getByTestId('host-pubkey-display').textContent).toBe('{"kty":"OKP","x":"rotated-key"}')
      })
    })

    it('shows the server message when the rotation fails', async () => {
      const user = setupUser()
      await openKeypairDialog(user)
      await user.click(await screen.findByRole('button', { name: 'Rotate keypair' }))
      keypairError = new Error('Rotation refused')
      await user.click(screen.getByRole('button', { name: 'Confirm rotation' }))
      await waitFor(() => {
        expect(toasts).toEqual([{ message: 'Rotation refused', severity: 'error' }])
      })
    })

    it('falls back to a plain message when the rotation fails without an Error', async () => {
      const user = setupUser()
      await openKeypairDialog(user)
      await user.click(await screen.findByRole('button', { name: 'Rotate keypair' }))
      keypairError = 'boom'
      await user.click(screen.getByRole('button', { name: 'Confirm rotation' }))
      await waitFor(() => {
        expect(toasts).toEqual([{ message: 'Failed to rotate keypair', severity: 'error' }])
      })
    })
  })

  describe('host list refresh', () => {
    it('shows the refreshed host after a health check', async () => {
      const user = setupUser()
      renderCard()
      await screen.findByText('v1.2.3')
      hostsRows = [makeHost({ agentVersion: '2.0.0' })]
      await user.click(screen.getByLabelText('check health'))
      await screen.findByText('v2.0.0')
    })

    it('shows the refreshed host after a successful TLS rotation but does not reload after a failed one', async () => {
      const user = setupUser()
      renderCard()
      await screen.findByText('v1.2.3')
      const invalidate = spyOn(lastQueryClient!, 'invalidateQueries')
      rotateTlsResult = Promise.resolve({ ok: false, code: 'pin_missing', message: 'no pin' })
      await user.click(screen.getByLabelText('rotate TLS'))
      await waitFor(() => expect(toasts).toHaveLength(1))
      expect(invalidate).not.toHaveBeenCalled()
      hostsRows = [makeHost({ agentVersion: '2.0.0' })]
      rotateTlsResult = Promise.resolve({ ok: true, hostId: 1, agentUrl: 'https://server1:9090' })
      await user.click(screen.getByLabelText('rotate TLS'))
      await screen.findByText('v2.0.0')
    })

    it('shows the refreshed list after a removal', async () => {
      const user = setupUser()
      renderCard()
      await screen.findByText('server1')
      hostsRows = [makeHost({ id: 2, name: 'server2' })]
      await user.click(screen.getByLabelText('remove host'))
      await user.click(screen.getByRole('button', { name: 'Remove' }))
      await screen.findByText('server2')
      await waitFor(() => expect(screen.queryAllByText('server1').length).toBe(0))
    })

    it('shows the refreshed host after an update', async () => {
      const user = setupUser()
      renderCard()
      await screen.findByText('server1')
      hostsRows = [makeHost({ name: 'renamed' })]
      await user.click(screen.getByLabelText('edit host'))
      await user.click(screen.getByRole('button', { name: 'Save' }))
      await screen.findByText('renamed')
    })
  })
})

describe('ManagedHostsCardConnected add-host flow', () => {
  // The Compose step's Next is disabled until the pending host (and its keypair)
  // exists, so navigation must wait for the creation to settle before advancing.
  async function waitForPendingHost() {
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(false)
    })
    // The create's onSuccess invalidates the hosts list. Wait for that refetch so
    // live-status checks read the pending row, not the pre-create snapshot.
    await act(async () => {
      await lastQueryClient!.refetchQueries({ queryKey: ['managed-hosts'] })
    })
  }

  // Simulates the worker sweep flipping the row to enrolled after the create response.
  async function flipHostToHealthy() {
    hostsRows = [makeHost({ status: 'healthy' })]
    await act(async () => {
      await lastQueryClient!.refetchQueries({ queryKey: ['managed-hosts'] })
    })
    // The flipped row renders its Rotate TLS action once the refetch reaches the card;
    // waitFor it so the click below acts on the flipped row, not a queued render.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'rotate TLS' })).toBeDefined()
    })
  }

  async function navigateToVerify(user: TestUser) {
    renderCard()
    await user.type(screen.getByLabelText('Host Name'), 'newhost')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await user.click(screen.getByRole('button', { name: 'Next' }))
  }

  it('references the created host key in the compose when entering the Compose step', async () => {
    const user = setupUser()
    renderCard()
    await user.type(screen.getByLabelText('Host Name'), 'newhost')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => {
      expect(screen.getByTestId('step-compose').textContent).toContain('AGENT_TRUSTED_PUBKEY: ${AGENT_TRUSTED_PUBKEY}')
    })
    expect(createPendingHostCalls).toEqual([{ name: 'newhost' }])
  })

  it('creates the host and bakes AGENT_HOST_NAME into the compose under the same trimmed name', async () => {
    const user = setupUser()
    renderCard()
    await user.type(screen.getByLabelText('Host Name'), '  padded-host  ')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(createPendingHostCalls).toEqual([{ name: 'padded-host' }]))
    expect(screen.getByTestId('step-compose').textContent).toMatch(/AGENT_HOST_NAME: padded-host$/m)
  })

  it('provisions TLS against the candidate URL in one call and leaves the row untouched on failure', async () => {
    const user = setupUser()
    await navigateToVerify(user)
    // The Verify button enables once the pending host exists and a URL is entered.
    await user.type(screen.getByLabelText('Agent host or IP'), '10.1.1.99')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(false)
    })
    await user.click(screen.getByRole('button', { name: 'Verify Connection' }))

    await waitFor(() => {
      expect(rotateTlsCalls).toEqual([
        { data: { hostId: 1, agentUrl: 'http://10.1.1.99:9090', acceptPlaintextEnrollment: false } },
      ])
    })
    expect(updateHostCalls).toEqual([])
    expect(toasts).toEqual([{ message: 'Host verified. The agent is served over https://server1:9090.', severity: 'success' }])
  })

  it('a failed verify leaves the stored URL alone', async () => {
    const user = setupUser()
    await navigateToVerify(user)
    await user.type(screen.getByLabelText('Agent host or IP'), '10.1.1.99')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(false)
    })
    rotateTlsResult = Promise.resolve({ ok: false, code: 'agent_unreachable', message: 'the agent could not be reached to create its certificate' })
    await user.click(screen.getByRole('button', { name: 'Verify Connection' }))
    await waitFor(() => {
      expect(screen.getByTestId('rerun-provisioning')).toBeDefined()
    })
    expect(updateHostCalls).toEqual([])
  })

  it('cancel stops waiting, re-enables the form, and discards the late result', async () => {
    const user = setupUser()
    await navigateToVerify(user)
    await user.type(screen.getByLabelText('Agent host or IP'), '10.1.1.99')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(false)
    })
    let resolveRotate!: (result: RotateTlsResult) => void
    rotateTlsGate = new Promise<RotateTlsResult>((res) => { resolveRotate = res })
    await user.click(screen.getByRole('button', { name: 'Verify Connection' }))

    // In-flight: loading state, cancel action, everything disabled.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Verifying/ })).toBeDefined()
    })
    const cancelBtn = screen.getByTestId('cancel-provisioning')
    expect(cancelBtn).toBeDefined()
    expect(screen.getByRole('button', { name: 'Reset' }).hasAttribute('disabled')).toBe(true)

    await user.click(cancelBtn)
    // Back to idle: the Verify button is enabled again, no error is shown.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(false)
    })
    expect(screen.queryByTestId('cancel-provisioning')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()

    // A late server-side failure after cancel must not resurface as an error.
    resolveRotate({ ok: false, code: 'agent_unreachable', message: 'late failure after cancel' })
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('maps an Unauthorized enrollment rejection to key-mismatch guidance', async () => {
    const user = setupUser()
    await navigateToVerify(user)
    await user.type(screen.getByLabelText('Agent host or IP'), '10.1.1.99')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(false)
    })
    rotateTlsResult = Promise.resolve({ ok: false, code: 'signature_invalid', message: 'the agent rejected the certificate request (Unauthorized)' })
    await user.click(screen.getByRole('button', { name: 'Verify Connection' }))
    await waitFor(() => {
      expect(screen.getByText(/does not match this host/)).toBeDefined()
    })
    expect(screen.getByTestId('rerun-provisioning')).toBeDefined()
  })

  it('shows the provisioning error with a re-run action when provisioning fails', async () => {
    const user = setupUser()
    await navigateToVerify(user)
    await user.type(screen.getByLabelText('Agent host or IP'), '10.1.1.99')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(false)
    })
    rotateTlsResult = Promise.resolve({ ok: false, code: 'poll_timeout', message: 'the agent did not serve the new certificate in time (connection refused)' })
    await user.click(screen.getByRole('button', { name: 'Verify Connection' }))

    await waitFor(() => {
      expect(screen.getByTestId('rerun-provisioning')).toBeDefined()
    })
    expect(screen.getByText(/did not serve the new certificate over HTTPS in time/)).toBeDefined()
  })

  it('shows unrecognized provisioning failures with a re-run hint appended', async () => {
    const user = setupUser()
    await navigateToVerify(user)
    await user.type(screen.getByLabelText('Agent host or IP'), '10.1.1.99')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(false)
    })
    rotateTlsResult = Promise.resolve({ ok: false, code: 'unexpected_agent_response', message: 'the agent answered with something unrecognised' })
    await user.click(screen.getByRole('button', { name: 'Verify Connection' }))
    await waitFor(() => {
      expect(screen.getByText(/Use Re-run provisioning below to try again/)).toBeDefined()
    })
  })

  it('drops the stale pending host and creates a new one when the name changes', async () => {
    const user = setupUser()
    renderCard()
    await user.type(screen.getByLabelText('Host Name'), 'host-a')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.clear(screen.getByLabelText('Host Name'))
    await user.type(screen.getByLabelText('Host Name'), 'host-b')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => {
      expect(createPendingHostCalls).toEqual([{ name: 'host-a' }, { name: 'host-b' }])
    })
    expect(removeHostCalls).toEqual([1])
  })

  it('Reset treats a no-longer-pending rejection as a silent success and clears the wizard', async () => {
    const user = setupUser()
    // Stale-cache simulation: the list still serves the row as pending, but the
    // server flips it between the snapshot and the removal, so removeHost rejects.
    renderCard()
    await user.type(screen.getByLabelText('Host Name'), 'newhost')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    removeHostError = new Error('Host server1 is no longer pending')
    const invalidate = spyOn(lastQueryClient!, 'invalidateQueries')
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['managed-hosts'] })
    })
    expect(screen.queryAllByTestId('step-compose').length).toBe(0)
    expect(removeHostCalls).toEqual([1])
    expect(removeHostData).toEqual([{ hostId: 1, expectStatus: 'pending' }])
    expect(toasts).toEqual([])
  })

  it('a rename treats a no-longer-pending stale record as gone and still creates the renamed one', async () => {
    const user = setupUser()
    renderCard()
    await user.type(screen.getByLabelText('Host Name'), 'host-a')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    removeHostError = new Error('Host host-a is no longer pending')
    await user.clear(screen.getByLabelText('Host Name'))
    await user.type(screen.getByLabelText('Host Name'), 'host-b')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => {
      expect(createPendingHostCalls).toEqual([{ name: 'host-a' }, { name: 'host-b' }])
    })
    expect(removeHostCalls).toEqual([1])
    expect(removeHostData).toEqual([{ hostId: 1, expectStatus: 'pending' }])
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(false)
    })
    expect(screen.getByTestId('step-compose')).toBeDefined()
    expect(screen.queryAllByRole('alert').length).toBe(0)
    expect(toasts).toEqual([])
  })

  it('treats a discard whose pending row was already removed elsewhere as a silent success', async () => {
    const user = setupUser()
    renderCard()
    await user.type(screen.getByLabelText('Host Name'), 'newhost')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    removeHostError = new Error('Host with id 1 not found')
    const invalidate = spyOn(lastQueryClient!, 'invalidateQueries')
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['managed-hosts'] })
    })
    expect(toasts).toEqual([])
  })

  it('treats a stale pending host removed elsewhere as gone and still creates the renamed one', async () => {
    const user = setupUser()
    renderCard()
    await user.type(screen.getByLabelText('Host Name'), 'host-a')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    removeHostError = new Error('Host with id 1 not found')
    await user.clear(screen.getByLabelText('Host Name'))
    await user.type(screen.getByLabelText('Host Name'), 'host-b')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => {
      expect(createPendingHostCalls).toEqual([{ name: 'host-a' }, { name: 'host-b' }])
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(false)
    })
    expect(screen.getByTestId('step-compose')).toBeDefined()
    expect(screen.queryAllByRole('alert').length).toBe(0)
    expect(toasts).toEqual([])
  })

  it('restores the original pending host when the rename stale removal fails', async () => {
    const user = setupUser()
    // A distinctive keypair makes the restored host-a record observable in the
    // rendered .env: a duplicated creation would carry a different publicJwk.
    createPendingHostResult = Promise.resolve({
      host: makeHost({ status: 'pending' }),
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'host-a-key' },
    })
    renderCard()
    await user.type(screen.getByLabelText('Host Name'), 'host-a')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    removeHostError = new Error('remove failed: connection reset by peer')
    await user.clear(screen.getByLabelText('Host Name'))
    await user.type(screen.getByLabelText('Host Name'), 'host-b')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(false)
    })
    expect(createPendingHostCalls).toEqual([{ name: 'host-a' }])
    expect(removeHostCalls).toEqual([1])
    // The wizard renders the restored pending state: advancing past the Compose
    // step shows the .env carrying host-a's original keypair.
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => {
      expect(screen.getByTestId('step-env').textContent).toContain('host-a-key')
    })
  })

  it('Reset removes the wizard-created pending host', async () => {
    const user = setupUser()
    renderCard()
    await user.type(screen.getByLabelText('Host Name'), 'newhost')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    expect(removeHostCalls).toEqual([1])
  })

  it('Reset does not remove an enrolled host returned by get-or-create', async () => {
    const user = setupUser()
    createPendingHostResult = Promise.resolve({
      host: makeHost({ status: 'healthy' }),
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'wizard-key-x' },
    })
    renderCard()
    await user.type(screen.getByLabelText('Host Name'), 'newhost')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    expect(removeHostCalls).toEqual([])
  })

  it('a server-side status flip keeps a rename from deleting the enrolled host', async () => {
    const user = setupUser()
    renderCard()
    await user.type(screen.getByLabelText('Host Name'), 'host-a')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    // The worker sweep enrolled the host after the create response: the list now
    // shows healthy while the wizard still holds a pending snapshot.
    await flipHostToHealthy()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.clear(screen.getByLabelText('Host Name'))
    await user.type(screen.getByLabelText('Host Name'), 'host-b')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => {
      expect(createPendingHostCalls).toEqual([{ name: 'host-a' }, { name: 'host-b' }])
    })
    expect(removeHostCalls).toEqual([])
  })

  it('a server-side status flip keeps Reset from deleting the enrolled host', async () => {
    const user = setupUser()
    renderCard()
    await user.type(screen.getByLabelText('Host Name'), 'newhost')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    await flipHostToHealthy()
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    await act(async () => {})
    expect(removeHostCalls).toEqual([])
  })

  it('a rename clears the previous host\'s provisioning error from the Verify step', async () => {
    const user = setupUser()
    renderCard()
    await user.type(screen.getByLabelText('Host Name'), 'host-a')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await user.type(screen.getByLabelText('Agent host or IP'), '10.1.1.99')
    rotateTlsResult = Promise.resolve({ ok: false, code: 'signature_invalid', message: 'the agent rejected the certificate request (Unauthorized)' })
    await user.click(screen.getByRole('button', { name: 'Verify Connection' }))
    await waitFor(() => {
      expect(screen.getByText(/does not match this host/)).toBeDefined()
    })
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.clear(screen.getByLabelText('Host Name'))
    await user.type(screen.getByLabelText('Host Name'), 'host-b')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => {
      expect(screen.getByTestId('step-verify')).toBeDefined()
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })
  async function startVerify(user: TestUser) {
    await navigateToVerify(user)
    await user.type(screen.getByLabelText('Agent host or IP'), '10.1.1.99')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(false)
    })
  }

  it('asks for confirmation before enrolling over plain HTTP, then sends the consent and clears it on success', async () => {
    const user = setupUser()
    await startVerify(user)
    rotateTlsResult = Promise.resolve({ ok: false, code: 'plaintext_confirmation_required', message: 'plain http' })
    await user.click(screen.getByRole('button', { name: 'Verify Connection' }))
    await waitFor(() => {
      expect(screen.getByText(/the certificate it presents would be accepted on first use/)).toBeDefined()
    })

    rotateTlsResult = Promise.resolve({ ok: true, hostId: 1, agentUrl: 'https://10.1.1.99:9090', enrolledOverPlainHttp: true })
    await user.click(screen.getByTestId('rerun-provisioning'))
    await waitFor(() => {
      expect(toasts).toHaveLength(1)
    })
    expect(toasts[0]).toEqual({
      message:
        'Host verified. The agent is served over https://10.1.1.99:9090. It had no certificate, so the new one was accepted on first use over plain HTTP. Compare the fingerprint in this host\'s keypair dialog with the one the agent prints at startup (docker logs hlm-agent).',
      severity: 'warning',
    })
    expect(rotateTlsCalls.map((c) => c.data.acceptPlaintextEnrollment)).toEqual([false, true])
    expect(screen.queryAllByRole('alert').length).toBe(0)

    await user.click(screen.getByRole('button', { name: 'Verify Connection' }))
    await waitFor(() => expect(rotateTlsCalls).toHaveLength(3))
    expect(rotateTlsCalls[2].data.acceptPlaintextEnrollment).toBe(false)
  })

  it('shows the refreshed hosts after a successful verification but does not reload after a failed one', async () => {
    const user = setupUser()
    await startVerify(user)
    const invalidate = spyOn(lastQueryClient!, 'invalidateQueries')
    rotateTlsResult = Promise.resolve({ ok: false, code: 'poll_timeout', message: 'timed out' })
    await user.click(screen.getByRole('button', { name: 'Verify Connection' }))
    await waitFor(() => expect(screen.getByTestId('rerun-provisioning')).toBeDefined())
    expect(invalidate).not.toHaveBeenCalled()
    hostsRows = [makeHost({ agentVersion: '2.0.0', status: 'healthy' })]
    rotateTlsResult = Promise.resolve({ ok: true, hostId: 1, agentUrl: 'https://10.1.1.99:9090' })
    await user.click(screen.getByTestId('rerun-provisioning'))
    await screen.findByText('v2.0.0')
  })

  it('verifies the host the wizard created, not a fixed id', async () => {
    const user = setupUser()
    createPendingHostResult = Promise.resolve({
      host: makeHost({ id: 5, status: 'pending' }),
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'wizard-key-x' },
    })
    hostsRows = [makeHost({ id: 5, status: 'pending' })]
    await startVerify(user)
    await user.click(screen.getByRole('button', { name: 'Verify Connection' }))
    await waitFor(() => {
      expect(rotateTlsCalls).toEqual([
        { data: { hostId: 5, agentUrl: 'http://10.1.1.99:9090', acceptPlaintextEnrollment: false } },
      ])
    })
  })

  it('cancelling while a re-run is in flight clears the previous failure', async () => {
    const user = setupUser()
    await startVerify(user)
    rotateTlsResult = Promise.resolve({ ok: false, code: 'poll_timeout', message: 'timed out' })
    await user.click(screen.getByRole('button', { name: 'Verify Connection' }))
    await waitFor(() => expect(screen.getByTestId('rerun-provisioning')).toBeDefined())

    rotateTlsGate = new Promise<RotateTlsResult>(() => undefined)
    await user.click(screen.getByTestId('rerun-provisioning'))
    await waitFor(() => expect(screen.getByTestId('cancel-provisioning')).toBeDefined())
    expect(screen.getByRole('alert')).toBeDefined()

    await user.click(screen.getByTestId('cancel-provisioning'))
    await waitFor(() => expect(screen.queryAllByTestId('cancel-provisioning').length).toBe(0))
    expect(screen.queryAllByRole('alert').length).toBe(0)
  })

  it('shows the error message when provisioning throws', async () => {
    const user = setupUser()
    await startVerify(user)
    rotateTlsGate = Promise.reject(new Error('Session expired'))
    rotateTlsGate.catch(() => null)
    await user.click(screen.getByRole('button', { name: 'Verify Connection' }))
    await waitFor(() => {
      expect(screen.getByText('Session expired')).toBeDefined()
    })
    expect(screen.getByText('Use Re-run provisioning below to try again.')).toBeDefined()
  })

  it('discards a throw that arrives after the operator cancelled', async () => {
    const user = setupUser()
    await startVerify(user)
    let rejectRotate!: (reason: unknown) => void
    rotateTlsGate = new Promise<RotateTlsResult>((_res, rej) => { rejectRotate = rej })
    rotateTlsGate.catch(() => null)
    await user.click(screen.getByRole('button', { name: 'Verify Connection' }))
    await waitFor(() => expect(screen.getByTestId('cancel-provisioning')).toBeDefined())
    await user.click(screen.getByTestId('cancel-provisioning'))
    await waitFor(() => expect(screen.queryAllByTestId('cancel-provisioning').length).toBe(0))

    rejectRotate(new Error('late throw after cancel'))
    await waitFor(() => expect(lastQueryClient!.isMutating()).toBe(0))
    expect(screen.queryAllByText('late throw after cancel').length).toBe(0)
    expect(screen.queryAllByRole('alert').length).toBe(0)
  })

  it('shows the server message when creating the pending host fails', async () => {
    const user = setupUser()
    createPendingHostResult = Promise.reject(new Error('Host name is already taken'))
    createPendingHostResult.catch(() => null)
    renderCard()
    await user.type(screen.getByLabelText('Host Name'), 'newhost')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => {
      expect(screen.getByText('Host name is already taken')).toBeDefined()
    })
  })

  it('falls back to a plain message when creating the pending host fails without an Error', async () => {
    const user = setupUser()
    createPendingHostResult = rejectWith('boom')
    createPendingHostResult.catch(() => null)
    renderCard()
    await user.type(screen.getByLabelText('Host Name'), 'newhost')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => {
      expect(screen.getByText('Failed to create the pending host')).toBeDefined()
    })
  })

  it('keeps the pending host when the name is unchanged after going back', async () => {
    const user = setupUser()
    createPendingHostResult = Promise.resolve({
      host: makeHost({ name: 'host-a', status: 'pending' }),
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'wizard-key-x' },
    })
    renderCard()
    await user.type(screen.getByLabelText('Host Name'), 'host-a')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => {
      expect(createPendingHostCalls).toEqual([{ name: 'host-a' }, { name: 'host-a' }])
    })
    expect(removeHostCalls).toEqual([])
  })

  it('tells the operator when the pending host could not be removed on Reset', async () => {
    const user = setupUser()
    renderCard()
    await user.type(screen.getByLabelText('Host Name'), 'newhost')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    removeHostError = new Error('database is locked')
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => {
      expect(toasts).toEqual([{ message: 'database is locked', severity: 'error' }])
    })
  })

  it('falls back to a plain message when Reset fails without an Error', async () => {
    const user = setupUser()
    renderCard()
    await user.type(screen.getByLabelText('Host Name'), 'newhost')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    removeHostError = 'boom'
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => {
      expect(toasts).toEqual([{ message: 'Failed to remove host', severity: 'error' }])
    })
  })
})
