import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AgentInventoryEntry } from '@/lib/hosts/agent-inventory'

const makeAgent = (overrides?: Partial<AgentInventoryEntry>): AgentInventoryEntry => ({
  id: 1,
  name: 'homeserver',
  agentUrl: 'http://192.168.1.10:9090',
  capabilities: { docker: true },
  status: 'online',
  version: '0.2.0',
  versionSource: 'live',
  agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent:latest',
  agentImageTag: 'latest',
  lastError: null,
  checkedAt: '2026-09-25T23:00:00.000Z',
  ...overrides,
})

const noop = () => {}

function makeProps(overrides?: Partial<import('@/components/agents/AgentsOverview').AgentsOverviewProps>) {
  return {
    agents: [makeAgent()],
    isLoading: false,
    isError: false,
    isAdmin: true,
    busyByHost: {},
    feedbackByHost: {},
    onUpdate: mock(noop),
    onRetry: mock(noop),
    ...overrides,
  }
}

const AgentsOverviewModule = import('@/components/agents/AgentsOverview')

describe('AgentsOverviewView', () => {
  it('shows a loading state', async () => {
    const { AgentsOverviewView } = await AgentsOverviewModule
    render(<AgentsOverviewView {...makeProps({ isLoading: true, agents: [] })} />)
    expect(screen.getByText('Loading agents…')).toBeDefined()
  })

  it('shows an error state with a retry button', async () => {
    const { AgentsOverviewView } = await AgentsOverviewModule
    const onRetry = mock(noop)
    render(<AgentsOverviewView {...makeProps({ isError: true, agents: [], onRetry })} />)
    expect(screen.getByText('Failed to load agents')).toBeDefined()
    fireEvent.click(screen.getByLabelText('Retry loading agents'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('shows an empty state when no agents are registered', async () => {
    const { AgentsOverviewView } = await AgentsOverviewModule
    render(<AgentsOverviewView {...makeProps({ agents: [] })} />)
    expect(screen.getByText('No agents registered')).toBeDefined()
  })

  it('renders name, status, version, and URL per agent', async () => {
    const { AgentsOverviewView } = await AgentsOverviewModule
    render(
      <AgentsOverviewView
        {...makeProps({
          agents: [
            makeAgent(),
            makeAgent({ id: 2, name: 'media-server', status: 'offline', version: '0.1.0', versionSource: 'stored', lastError: 'timed out', agentUrl: 'http://192.168.1.20:9090' }),
          ],
        })}
      />,
    )
    expect(screen.getByText('homeserver')).toBeDefined()
    expect(screen.getByText('media-server')).toBeDefined()
    expect(screen.getByText('Online')).toBeDefined()
    expect(screen.getByText('Offline')).toBeDefined()
    expect(screen.getByText('v0.2.0')).toBeDefined()
    expect(screen.getByText('v0.1.0')).toBeDefined()
    expect(screen.getByText('http://192.168.1.10:9090')).toBeDefined()
    expect(screen.getByText('timed out')).toBeDefined()
  })

  it('lets an admin trigger the update for one row without touching the other', async () => {
    const { AgentsOverviewView } = await AgentsOverviewModule
    const onUpdate = mock(noop)
    render(
      <AgentsOverviewView
        {...makeProps({
          agents: [makeAgent(), makeAgent({ id: 2, name: 'media-server' })],
          onUpdate,
        })}
      />,
    )
    fireEvent.click(screen.getByLabelText('Update media-server'))
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate).toHaveBeenCalledWith(2)
  })

  it('disables update controls for non-admins', async () => {
    const { AgentsOverviewView } = await AgentsOverviewModule
    const onUpdate = mock(noop)
    render(<AgentsOverviewView {...makeProps({ isAdmin: false, onUpdate })} />)
    const updateButton = screen.getByLabelText('Update homeserver')
    expect(updateButton.hasAttribute('disabled')).toBe(true)
    fireEvent.click(updateButton)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('shows per-row feedback and busy state without affecting other rows', async () => {
    const { AgentsOverviewView } = await AgentsOverviewModule
    render(
      <AgentsOverviewView
        {...makeProps({
          agents: [makeAgent(), makeAgent({ id: 2, name: 'media-server' })],
          busyByHost: { 1: 'update' },
          feedbackByHost: { 2: { severity: 'success', message: 'Update confirmed, agent now on v0.3.0' } },
        })}
      />,
    )
    expect(screen.getByLabelText('Update homeserver').hasAttribute('disabled')).toBe(true)
    expect(screen.getByLabelText('Update media-server').hasAttribute('disabled')).toBe(false)
    expect(screen.getByText('Update confirmed, agent now on v0.3.0')).toBeDefined()
  })
})

describe('AgentsOverview (connected)', () => {
  const listAgentsInventory = mock(() => Promise.resolve([makeAgent(), makeAgent({ id: 2, name: 'media-server' })]))
  const updateAgent = mock((_data: { data: { hostId: number } }) =>
    Promise.resolve({ hostId: 1, healthy: true, version: '0.3.0' }),
  )

  let authState: { user: { id: number; email: string; name: string | null; role: 'admin' | 'operator' | 'viewer' } | null; loading: boolean; authEnabled: boolean } = {
    user: { id: 1, email: 'a@b.c', name: 'Admin', role: 'admin' },
    loading: false,
    authEnabled: true,
  }

  mock.module('@/hooks/useAuth', () => ({
    useAuth: () => authState,
  }))

  let sseHandler: ((snapshot: { entries: AgentInventoryEntry[] }) => void) | null = null

  mock.module('@/lib/mux/use-mux-channel', () => ({
    useMuxChannel: (_channel: unknown, options: { onData: (data: { entries: AgentInventoryEntry[] }) => void }) => {
      sseHandler = options.onData
      return { isConnected: true, error: null }
    },
  }))

  mock.module('@/data/hosts/functions', () => ({
    listAgentsInventory: () => listAgentsInventory(),
    updateAgent: (data: { data: { hostId: number } }) => updateAgent(data),
  }))

  beforeEach(() => {
    listAgentsInventory.mockImplementation(() => Promise.resolve([makeAgent(), makeAgent({ id: 2, name: 'media-server' })]))
    updateAgent.mockImplementation(() => Promise.resolve({ hostId: 1, healthy: true, version: '0.3.0' }))
    authState = { user: { id: 1, email: 'a@b.c', name: 'Admin', role: 'admin' }, loading: false, authEnabled: true }
  })

  function renderConnected() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
    return import('@/components/agents/AgentsOverview').then(({ default: AgentsOverview }) =>
      render(
        <QueryClientProvider client={queryClient}>
          <AgentsOverview />
        </QueryClientProvider>,
      ),
    )
  }

  it('applies an SSE snapshot to the rendered rows', async () => {
    renderConnected()
    await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())

    sseHandler!({ entries: [makeAgent({ version: '9.9.9' })] })

    await waitFor(() => expect(screen.getByText('v9.9.9')).toBeDefined())
  })

  it('updates only the clicked agent and surfaces the result on that row', async () => {
    renderConnected()
    await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Update homeserver'))
    await waitFor(() => expect(screen.getByText('Update confirmed, agent now on v0.3.0')).toBeDefined())
    expect(updateAgent).toHaveBeenCalledTimes(1)
    expect(updateAgent).toHaveBeenCalledWith({ data: { hostId: 1 } })
    expect(screen.getByTestId('agent-row-media-server').textContent).not.toContain('Update confirmed')
  })

  it('shows a per-row failure when the update fails', async () => {
    updateAgent.mockImplementation(() => Promise.reject(new Error('agent unreachable')))
    renderConnected()
    await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Update homeserver'))
    await waitFor(() => expect(screen.getByText('agent unreachable')).toBeDefined())
    expect(screen.getByTestId('agent-row-media-server').textContent).not.toContain('agent unreachable')
  })

  it('blocks updates for non-admins', async () => {
    authState = { user: { id: 2, email: 'a@b.c', name: 'Viewer', role: 'viewer' }, loading: false, authEnabled: true }
    renderConnected()
    await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
    const updateButton = screen.getByLabelText('Update homeserver')
    expect(updateButton.hasAttribute('disabled')).toBe(true)
  })
})
