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
  agentUpdaterImageDigest: 'sha256:' + 'a'.repeat(64),
  agentUpdaterImageTag: 'latest',
  updaterOutOfDate: false,
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

let inventoryResponse: AgentInventoryEntry[] = []
type OpResult = import('@/data/hosts/handlers').HostOperationResult
let updateResult: Promise<OpResult> = Promise.resolve({ hostId: 1, healthy: true })
let updateCalls: Array<{ data: { hostId: number } }> = []
const listAgentsInventory = (): Promise<AgentInventoryEntry[]> => Promise.resolve(inventoryResponse)
const updateAgent = (data: { data: { hostId: number } }) => {
  updateCalls.push(data)
  return updateResult
}

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

describe('AgentsOverviewView', () => {
  it('shows a loading state', async () => {
    const { AgentsOverviewView } = await import('@/components/agents/AgentsOverview')
    render(<AgentsOverviewView {...makeProps({ isLoading: true, agents: [] })} />)
    expect(screen.getByText('Loading agents…')).toBeDefined()
  })

  it('shows an error state with a retry button', async () => {
    const { AgentsOverviewView } = await import('@/components/agents/AgentsOverview')
    const onRetry = mock(noop)
    render(<AgentsOverviewView {...makeProps({ isError: true, agents: [], onRetry })} />)
    expect(screen.getByText('Failed to load agents')).toBeDefined()
    fireEvent.click(screen.getByLabelText('Retry loading agents'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('shows an empty state when no agents are registered', async () => {
    const { AgentsOverviewView } = await import('@/components/agents/AgentsOverview')
    render(<AgentsOverviewView {...makeProps({ agents: [] })} />)
    expect(screen.getByText('No agents registered')).toBeDefined()
  })

  it('renders name, status, version, and URL per agent', async () => {
    const { AgentsOverviewView } = await import('@/components/agents/AgentsOverview')
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
    const { AgentsOverviewView } = await import('@/components/agents/AgentsOverview')
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
    const { AgentsOverviewView } = await import('@/components/agents/AgentsOverview')
    const onUpdate = mock(noop)
    render(<AgentsOverviewView {...makeProps({ isAdmin: false, onUpdate })} />)
    const updateButton = screen.getByLabelText('Update homeserver')
    expect(updateButton.hasAttribute('disabled')).toBe(true)
    fireEvent.click(updateButton)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('shows per-row feedback and busy state without affecting other rows', async () => {
    const { AgentsOverviewView } = await import('@/components/agents/AgentsOverview')
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

  it('renders the out-of-date updater warning with the regeneration fix on that row and in a callout', async () => {
    const { AgentsOverviewView, UPDATER_OUT_OF_DATE_MESSAGE } = await import('@/components/agents/AgentsOverview')
    render(
      <AgentsOverviewView
        {...makeProps({
          agents: [makeAgent({ updaterOutOfDate: true }), makeAgent({ id: 2, name: 'media-server' })],
        })}
      />,
    )
    expect(screen.getByLabelText('agent-updater out of date')).toBeDefined()
    expect(screen.getByTestId('updater-out-of-date-callout')).toBeDefined()
    expect(screen.getByText('The agent-updater is out of date on 1 host')).toBeDefined()
    expect(screen.getByText(UPDATER_OUT_OF_DATE_MESSAGE)).toBeDefined()
    expect(screen.getByTestId('agent-row-media-server').textContent).not.toContain('updater out of date')
  })

  it('renders no updater warning when every sidecar is current', async () => {
    const { AgentsOverviewView } = await import('@/components/agents/AgentsOverview')
    render(
      <AgentsOverviewView
        {...makeProps({
          agents: [makeAgent(), makeAgent({ id: 2, name: 'media-server', updaterOutOfDate: false })],
        })}
      />,
    )
    expect(screen.queryByLabelText('agent-updater out of date')).toBeNull()
    expect(screen.queryByTestId('updater-out-of-date-callout')).toBeNull()
  })

  it('renders the pinned regeneration copy verbatim', async () => {
    const { AgentsOverviewView, UPDATER_OUT_OF_DATE_MESSAGE } = await import('@/components/agents/AgentsOverview')
    expect(UPDATER_OUT_OF_DATE_MESSAGE).toBe(
      'The agent-updater on this host is out of date and can no longer be updated remotely. Regenerate the compose stack: Settings, Manage Hosts, then run docker compose up -d on the host.',
    )
    render(<AgentsOverviewView {...makeProps({ agents: [makeAgent({ updaterOutOfDate: true })] })} />)
    expect(screen.getByText(UPDATER_OUT_OF_DATE_MESSAGE)).toBeDefined()
  })
})

describe('AgentsOverview (connected)', () => {

  beforeEach(() => {
    inventoryResponse = [makeAgent(), makeAgent({ id: 2, name: 'media-server' })]
    updateResult = Promise.resolve({ hostId: 1, healthy: true, version: '0.3.0' })
    updateCalls = []
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
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0]).toEqual({ data: { hostId: 1 } })
    expect(screen.getByTestId('agent-row-media-server').textContent).not.toContain('Update confirmed')
  })

  it('shows a per-row failure when the update fails', async () => {
    const rejection = Promise.reject(new Error('agent unreachable'))
    rejection.catch(() => {}) // handled by the component on click; pre-catch silences the floating-rejection check
    updateResult = rejection
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
