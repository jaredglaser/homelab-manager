import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { mockModule } from '@/lib/test/mock-module'
// Registers RTL auto-cleanup: without it, earlier tests' renders stay mounted and
// screen.* queries and clicks leak into whichever wizard was mounted first.
import '@/lib/test/testing-library'
import type { HostListItem } from '@/lib/hosts/host-utils'

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

type RotateTlsResult = { hostId: number; agentUrl: string }
let rotateTlsResult: Promise<RotateTlsResult> = Promise.resolve({ hostId: 1, agentUrl: 'https://server1:9090' })
let rotateTlsCalls: Array<{ data: { hostId: number; agentUrl?: string } }> = []
// When set, rotateHostTls returns this manually-settled promise instead.
let rotateTlsGate: Promise<RotateTlsResult> | null = null

const rotateHostTls = (data: { data: { hostId: number; agentUrl?: string } }): Promise<RotateTlsResult> => {
  rotateTlsCalls.push(data)
  return rotateTlsGate ?? rotateTlsResult
}

type CreatePendingHostResult = { host: HostListItem; publicJwk: Record<string, string> }
let createPendingHostResult: Promise<CreatePendingHostResult> = Promise.resolve({
  host: makeHost({ status: 'pending' }),
  publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'wizard-key-x' },
})
let createPendingHostCalls: Array<{ name: string }> = []

const createPendingHost = (data: { data: { name: string; capabilities?: { docker?: boolean; zfs?: boolean } } }): Promise<CreatePendingHostResult> => {
  createPendingHostCalls.push({ name: data.data.name })
  return createPendingHostResult
}

let removeHostCalls: number[] = []
// When set, removeHost rejects with this error instead of resolving.
let removeHostError: unknown = null
const removeHost = (data: { data: { hostId: number } }): Promise<{ success: boolean }> => {
  removeHostCalls.push(data.data.hostId)
  if (removeHostError != null) return Promise.reject(removeHostError)
  return Promise.resolve({ success: true })
}

let updateHostCalls: Array<{ hostId: number; agentUrl?: string }> = []
const updateHost = (data: { data: { hostId: number; agentUrl?: string } }): Promise<HostListItem> => {
  updateHostCalls.push({ hostId: data.data.hostId, agentUrl: data.data.agentUrl })
  return Promise.resolve(makeHost())
}

mock.module('@/data/hosts/functions', () => ({
  listHosts: () => Promise.resolve([makeHost()]),
  createPendingHost,
  removeHost,
  checkHostHealth: () => Promise.resolve({ hostId: 1, healthy: true }),
  updateHost,
  getHostPublicJwk: () => Promise.resolve({ publicJwk: {} }),
  rotateHostKeypair: () => Promise.resolve({ hostId: 1, publicJwk: {} }),
  rotateHostTls: (data: { data: { hostId: number } }) => rotateHostTls(data),
}))

function renderCard(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const { ManagedHostsCard } = require('@/components/settings/ManagedHostsCardConnected') as typeof import('@/components/settings/ManagedHostsCardConnected')
  render(
    <QueryClientProvider client={queryClient}>
      <ManagedHostsCard />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  rotateTlsGate = null
  rotateTlsCalls.length = 0
  removeHostCalls.length = 0
  removeHostError = null
  updateHostCalls.length = 0
  createPendingHostCalls.length = 0
  toasts.length = 0
  rotateTlsResult = Promise.resolve({ hostId: 1, agentUrl: 'https://server1:9090' })
  createPendingHostResult = Promise.resolve({
    host: makeHost({ status: 'pending' }),
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'wizard-key-x' },
  })
})

describe('ManagedHostsCardConnected rotate TLS toasts', () => {
  it('shows the pinned success toast after a successful rotation', async () => {
    renderCard()
    await screen.findByText('server1')
    rotateTlsResult = Promise.resolve({ hostId: 1, agentUrl: 'https://server1:9090' })

    fireEvent.click(screen.getByLabelText('rotate TLS'))

    await waitFor(() => {
      expect(
        toasts.some((t) => t.message === 'TLS certificate rotated for https://server1:9090. The agent is now serving the new certificate.'),
      ).toBe(true)
    })
    expect(rotateTlsCalls).toEqual([{ data: { hostId: 1 } }])
  })

  it('shows the pinned fallback toast when rotation fails without an Error', async () => {
    renderCard()
    await screen.findByText('server1')
    rotateTlsResult = Promise.reject('boom')

    fireEvent.click(screen.getByLabelText('rotate TLS'))

    await waitFor(() => {
      expect(toasts.some((t) => t.message === 'Failed to rotate the TLS certificate')).toBe(true)
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
  }

  async function navigateToVerify() {
    renderCard()
    fireEvent.change(screen.getByLabelText('Host Name'), { target: { value: 'newhost' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  }

  it('references the created host key in the compose when entering the Compose step', async () => {
    renderCard()
    fireEvent.change(screen.getByLabelText('Host Name'), { target: { value: 'newhost' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => {
      expect(screen.getByTestId('step-compose').textContent).toContain('AGENT_TRUSTED_PUBKEY: ${AGENT_TRUSTED_PUBKEY}')
    })
    expect(createPendingHostCalls).toEqual([{ name: 'newhost' }])
  })

  it('provisions TLS against the candidate URL in one call and leaves the row untouched on failure', async () => {
    await navigateToVerify()
    // The Verify button enables once the pending host exists and a URL is entered.
    fireEvent.change(screen.getByLabelText('Agent host or IP'), { target: { value: '10.1.1.99' } })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Verify Connection' }))

    await waitFor(() => {
      expect(rotateTlsCalls).toEqual([{ data: { hostId: 1, agentUrl: 'http://10.1.1.99:9090' } }])
    })
    expect(updateHostCalls).toEqual([])
    expect(toasts.some((t) => t.message.startsWith('Host verified.'))).toBe(true)
  })

  it('a failed verify leaves the stored URL alone', async () => {
    await navigateToVerify()
    fireEvent.change(screen.getByLabelText('Agent host or IP'), { target: { value: '10.1.1.99' } })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(false)
    })
    rotateTlsResult = Promise.reject(new Error('TLS provisioning failed: the agent could not be reached to create its certificate (unreachable).'))
    fireEvent.click(screen.getByRole('button', { name: 'Verify Connection' }))
    await waitFor(() => {
      expect(screen.getByTestId('rerun-provisioning')).toBeDefined()
    })
    expect(updateHostCalls).toEqual([])
  })

  it('cancel stops waiting, re-enables the form, and discards the late result', async () => {
    await navigateToVerify()
    fireEvent.change(screen.getByLabelText('Agent host or IP'), { target: { value: '10.1.1.99' } })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(false)
    })
    let rejectRotate!: (err: unknown) => void
    rotateTlsGate = new Promise<RotateTlsResult>((_res, rej) => { rejectRotate = rej })
    fireEvent.click(screen.getByRole('button', { name: 'Verify Connection' }))

    // In-flight: loading state, cancel action, everything disabled.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Verifying/ })).toBeDefined()
    })
    const cancelBtn = screen.getByTestId('cancel-provisioning')
    expect(cancelBtn).toBeDefined()
    expect(screen.getByRole('button', { name: 'Reset' }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(cancelBtn)
    // Back to idle: the Verify button is enabled again, no error is shown.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(false)
    })
    expect(screen.queryByTestId('cancel-provisioning')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()

    // A late server-side failure after cancel must not resurface as an error.
    rejectRotate(new Error('TLS provisioning failed: late failure after cancel'))
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('maps an Unauthorized enrollment rejection to key-mismatch guidance', async () => {
    await navigateToVerify()
    fireEvent.change(screen.getByLabelText('Agent host or IP'), { target: { value: '10.1.1.99' } })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(false)
    })
    rotateTlsResult = Promise.reject(new Error('TLS provisioning failed: the agent rejected the certificate request (Unauthorized). Fix the agent, then re-run TLS provisioning from the Managed Hosts card.'))
    fireEvent.click(screen.getByRole('button', { name: 'Verify Connection' }))
    await waitFor(() => {
      expect(screen.getByText(/does not match this host/)).toBeDefined()
    })
    expect(screen.getByTestId('rerun-provisioning')).toBeDefined()
  })

  it('shows the provisioning error with a re-run action when provisioning fails', async () => {
    await navigateToVerify()
    fireEvent.change(screen.getByLabelText('Agent host or IP'), { target: { value: '10.1.1.99' } })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(false)
    })
    rotateTlsResult = Promise.reject(new Error('TLS provisioning failed: the agent did not become healthy over HTTPS (connection refused)'))
    fireEvent.click(screen.getByRole('button', { name: 'Verify Connection' }))

    await waitFor(() => {
      expect(screen.getByTestId('rerun-provisioning')).toBeDefined()
    })
    expect(screen.getByText(/TLS provisioning failed/)).toBeDefined()
  })

  it('shows unrecognized provisioning failures with a re-run hint appended', async () => {
    await navigateToVerify()
    fireEvent.change(screen.getByLabelText('Agent host or IP'), { target: { value: '10.1.1.99' } })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(false)
    })
    rotateTlsResult = Promise.reject(new Error('TLS provisioning failed: the agent did not become healthy over HTTPS (connection refused)'))
    fireEvent.click(screen.getByRole('button', { name: 'Verify Connection' }))
    await waitFor(() => {
      expect(screen.getByText(/Use Re-run provisioning below to try again/)).toBeDefined()
    })
  })

  it('drops the stale pending host and creates a new one when the name changes', async () => {
    renderCard()
    fireEvent.change(screen.getByLabelText('Host Name'), { target: { value: 'host-a' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.change(screen.getByLabelText('Host Name'), { target: { value: 'host-b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => {
      expect(createPendingHostCalls).toEqual([{ name: 'host-a' }, { name: 'host-b' }])
    })
    expect(removeHostCalls).toEqual([1])
  })

  it('treats a discard whose pending row was already removed elsewhere as a silent success', async () => {
    renderCard()
    fireEvent.change(screen.getByLabelText('Host Name'), { target: { value: 'newhost' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    removeHostError = new Error('Host not found')
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    await act(async () => {})
    expect(toasts).toEqual([])
  })

  it('treats a stale pending host removed elsewhere as gone and still creates the renamed one', async () => {
    renderCard()
    fireEvent.change(screen.getByLabelText('Host Name'), { target: { value: 'host-a' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    removeHostError = new Error('Host not found')
    fireEvent.change(screen.getByLabelText('Host Name'), { target: { value: 'host-b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => {
      expect(createPendingHostCalls).toEqual([{ name: 'host-a' }, { name: 'host-b' }])
    })
    expect(toasts).toEqual([])
  })

  it('restores the original pending host when the rename stale removal fails', async () => {
    renderCard()
    fireEvent.change(screen.getByLabelText('Host Name'), { target: { value: 'host-a' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    removeHostError = new Error('remove failed: connection reset by peer')
    fireEvent.change(screen.getByLabelText('Host Name'), { target: { value: 'host-b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(false)
    })
    expect(createPendingHostCalls).toEqual([{ name: 'host-a' }])
    expect(removeHostCalls).toEqual([1])
  })

  it('Reset removes the wizard-created pending host', async () => {
    renderCard()
    fireEvent.change(screen.getByLabelText('Host Name'), { target: { value: 'newhost' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(removeHostCalls).toEqual([1])
  })

  it('Reset does not remove an enrolled host returned by get-or-create', async () => {
    createPendingHostResult = Promise.resolve({
      host: makeHost({ status: 'healthy' }),
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'wizard-key-x' },
    })
    renderCard()
    fireEvent.change(screen.getByLabelText('Host Name'), { target: { value: 'newhost' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitForPendingHost()
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(removeHostCalls).toEqual([])
  })
})
