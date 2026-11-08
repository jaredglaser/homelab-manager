import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { mockModule } from '@/lib/test/mock-module'
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
let rotateTlsCalls: Array<{ data: { hostId: number } }> = []

const rotateHostTls = (data: { data: { hostId: number } }): Promise<RotateTlsResult> => {
  rotateTlsCalls.push(data)
  return rotateTlsResult
}

type VerifyHostResult = { host: HostListItem; publicJwk?: Record<string, unknown>; provisioningError?: string }
let verifyHostResult: Promise<VerifyHostResult> = Promise.resolve({ host: makeHost(), publicJwk: {} })
let verifyHostCalls: Array<{ name: string; agentUrl: string; capabilities?: { docker: boolean; zfs: boolean } }> = []

const verifyHost = (data: { data: { name: string; agentUrl: string } }): Promise<VerifyHostResult> => {
  verifyHostCalls.push(data.data)
  return verifyHostResult
}

beforeEach(() => {
  verifyHostCalls = []
})

mock.module('@/data/hosts/functions', () => ({
  listHosts: () => Promise.resolve([makeHost()]),
  verifyHost,
  removeHost: () => Promise.resolve({ success: true }),
  checkHostHealth: () => Promise.resolve({ hostId: 1, healthy: true }),
  updateHost: () => Promise.resolve(makeHost()),
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

describe('ManagedHostsCardConnected rotate TLS toasts', () => {
  it('shows the pinned success toast after a successful rotation', async () => {
    renderCard()
    await screen.findByText('server1')
    rotateTlsResult = Promise.resolve({ hostId: 1, agentUrl: 'https://server1:9090' })

    fireEvent.click(screen.getByLabelText('rotate TLS'))

    await waitFor(() => {
      expect(
        toasts.some((t) => t.message === 'TLS certificate rotated for https://server1:9090. The agent restarted with the new certificate.'),
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

describe('ManagedHostsCardConnected add-host verify flow', () => {
  it('shows the public JWK alongside the provisioning error when provisioning fails', async () => {
    verifyHostResult = Promise.resolve({
      host: makeHost({ status: 'pending' }),
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'enrolled-x' },
      provisioningError: 'TLS provisioning failed: the agent did not become healthy over HTTPS (connection refused)',
    })
    renderCard()
    fireEvent.change(screen.getByLabelText('Host Name'), { target: { value: 'newhost' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.change(screen.getByLabelText('Agent URL'), { target: { value: 'http://x:9090' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify Connection' }))

    await waitFor(() => {
      expect(screen.getByTestId('pubkey-display').textContent).toContain('enrolled-x')
    })
    expect(screen.getByTestId('rerun-provisioning')).toBeDefined()
    expect(toasts.some((t) => t.message.startsWith('Host added.'))).toBe(true)
    expect(verifyHostCalls).toEqual([{ name: 'newhost', agentUrl: 'http://x:9090', capabilities: { docker: true, zfs: false } }])
  })

  it('leaves the error alert empty when verify resolves without a provisioning error', async () => {
    verifyHostResult = Promise.resolve({
      host: makeHost({ status: 'pending' }),
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'enrolled-x' },
    })
    renderCard()
    fireEvent.change(screen.getByLabelText('Host Name'), { target: { value: 'newhost' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.change(screen.getByLabelText('Agent URL'), { target: { value: 'http://x:9090' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify Connection' }))

    await waitFor(() => {
      expect(screen.getByTestId('pubkey-display').textContent).toContain('enrolled-x')
    })
    expect(screen.queryByTestId('rerun-provisioning')).toBeNull()
    expect(toasts.some((t) => t.message.startsWith('Host added.'))).toBe(true)
  })
})
