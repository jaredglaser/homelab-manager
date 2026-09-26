import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AgentInventoryEntry } from '@/lib/hosts/agent-inventory'

// Register module mocks before any component import: a mock.module call made
// after the module graph has loaded leaves it wired to the real server fns.
let authState: { user: { id: number; email: string; name: string | null; role: 'admin' | 'operator' | 'viewer' } | null; loading: boolean; authEnabled: boolean } = {
  user: { id: 1, email: 'a@b.c', name: 'Admin', role: 'admin' },
  loading: false,
  authEnabled: true,
}

mock.module('@/hooks/useAuth', () => ({
  useAuth: () => authState,
}))

const listAgentsInventory = mock((): Promise<AgentInventoryEntry[]> => Promise.resolve([]))
const updateAgent = mock((_data: { data: { hostId: number } }) =>
  Promise.resolve({}) as Promise<import('@/data/hosts/handlers').HostOperationResult>,
)
const setAgentAutoUpdate = mock((_data: { data: { hostId: number; autoUpdate: boolean } }) =>
  Promise.resolve({} as import('@/data/hosts/handlers').SetAgentAutoUpdateResult as unknown),
)

mock.module('@/data/hosts/functions', () => ({
  listAgentsInventory: () => listAgentsInventory(),
  updateAgent: (data: { data: { hostId: number } }) => updateAgent(data),
  setAgentAutoUpdate: (data: { data: { hostId: number; autoUpdate: boolean } }) => setAgentAutoUpdate(data),
}))

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
  autoUpdate: false,
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
    onAutoUpdateChange: mock(noop),
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
    expect(screen.getByLabelText('Auto-update homeserver').getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(updateButton)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('reports auto-update toggle changes', async () => {
    const { AgentsOverviewView } = await AgentsOverviewModule
    const onAutoUpdateChange = mock(noop)
    render(<AgentsOverviewView {...makeProps({ onAutoUpdateChange })} />)
    const checkbox = screen.getByLabelText('Auto-update homeserver')
    fireEvent.click(checkbox)
    expect(onAutoUpdateChange).toHaveBeenCalledWith(1, true)
  })

  it('shows per-row feedback and busy state without affecting other rows', async () => {
    const { AgentsOverviewView } = await AgentsOverviewModule
    render(
      <AgentsOverviewView
        {...makeProps({
          agents: [makeAgent(), makeAgent({ id: 2, name: 'media-server', autoUpdate: true })],
          busyByHost: { 1: 'update' },
          feedbackByHost: { 2: { severity: 'success', message: 'Update confirmed, agent now on v0.3.0' } },
        })}
      />,
    )
    expect(screen.getByLabelText('Update homeserver').hasAttribute('disabled')).toBe(true)
    expect(screen.getByLabelText('Update media-server').hasAttribute('disabled')).toBe(false)
    expect(screen.getByLabelText('Auto-update homeserver').getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByLabelText('Auto-update media-server').getAttribute('aria-disabled')).toBe(null)
    expect(screen.getByText('Update confirmed, agent now on v0.3.0')).toBeDefined()
  })
})

describe('AgentsOverview (connected)', () => {
  beforeEach(() => {
    listAgentsInventory.mockImplementation(() => Promise.resolve([makeAgent(), makeAgent({ id: 2, name: 'media-server', autoUpdate: true })]))
    updateAgent.mockImplementation(() => Promise.resolve({ hostId: 1, healthy: true, version: '0.3.0' }))
    setAgentAutoUpdate.mockImplementation(() =>
      Promise.resolve({
        host: {
          id: 1,
          name: 'homeserver',
          agentUrl: 'http://192.168.1.10:9090',
          capabilities: { docker: true },
          agentVersion: '0.2.0',
          agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent:latest',
          agentImageTag: 'latest',
          autoUpdate: true,
          status: 'healthy',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        propagation: { applied: true },
      }),
    )
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

  it('shows an in-progress update as info, not raw JSON', async () => {
    updateAgent.mockImplementation(() =>
      Promise.resolve({ hostId: 1, healthy: false, error: 'An update is already in progress' })
    )
    renderConnected()
    await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Update homeserver'))
    await waitFor(() =>
      expect(screen.getByText('An update is already in progress for this agent')).toBeDefined()
    )
  })

  it('persists the auto-update opt-in when the checkbox is toggled', async () => {
    renderConnected()
    await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Auto-update homeserver'))
    await waitFor(() => expect(setAgentAutoUpdate).toHaveBeenCalledWith({ data: { hostId: 1, autoUpdate: true } }))
    await waitFor(() => expect(screen.getByLabelText('Auto-update homeserver').getAttribute('aria-checked')).toBe('false'))
  })

  it('reflects the stored auto-update value on load', async () => {
    renderConnected()
    await waitFor(() => expect(screen.getByLabelText('Auto-update media-server').getAttribute('aria-checked')).toBe('true'))
    expect(screen.getByLabelText('Auto-update homeserver').getAttribute('aria-checked')).toBe('false')
  })

  it('blocks updates for non-admins', async () => {
    authState = { user: { id: 2, email: 'a@b.c', name: 'Viewer', role: 'viewer' }, loading: false, authEnabled: true }
    renderConnected()
    await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
    const updateButton = screen.getByLabelText('Update homeserver')
    expect(updateButton.hasAttribute('disabled')).toBe(true)
    expect(screen.getByLabelText('Auto-update homeserver').getAttribute('aria-disabled')).toBe('true')
  })
})
