import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AgentInventoryEntry, AgentInventoryFailure } from '@/lib/hosts/agent-inventory'
import { AGENT_INVENTORY_STATUSES } from '@/lib/hosts/agent-inventory'

const makeAgent = (overrides?: Partial<AgentInventoryEntry>): AgentInventoryEntry => ({
  id: 1,
  name: 'homeserver',
  agentUrl: 'http://192.168.1.10:9090',
  capabilities: { docker: true },
  status: 'online',
  version: '0.2.0',
  agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent:latest',
  agentImageTag: 'latest',
  agentImageDigest: 'sha256:' + 'a'.repeat(64),
  agentOutOfDate: false,
  failure: null,
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
type OpResult = import('@/data/hosts/handlers').UpdateAgentResult
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
            makeAgent({ id: 2, name: 'media-server', status: 'offline', version: '0.1.0', failure: { code: 'offline', message: 'timed out' }, agentUrl: 'http://192.168.1.20:9090' }),
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
    expect(screen.getByText('The host did not answer the health check. Check that the agent container is running and reachable at the URL stored for this host, then check again.')).toBeDefined()
    expect(screen.getByText('timed out')).toBeDefined()
  })

  const FAILURE_COPY: Array<{ code: AgentInventoryFailure['code']; status: AgentInventoryEntry['status']; copy: string; showsDetail: boolean }> = [
    {
      code: 'offline',
      status: 'offline',
      copy: 'The host did not answer the health check. Check that the agent container is running and reachable at the URL stored for this host, then check again.',
      showsDetail: true,
    },
    {
      code: 'unreachable',
      status: 'unreachable',
      copy: 'Something answered at the host URL, but it is not a healthy agent. Check that the URL stored for this host points at the agent, then check again.',
      showsDetail: true,
    },
    {
      code: 'awaiting-enrollment',
      status: 'awaiting-enrollment',
      copy: 'The agent is serving plain HTTP because it holds no certificate yet. Enroll a certificate for this host, then check again.',
      showsDetail: false,
    },
    {
      code: 'agent-unhealthy',
      status: 'unreachable',
      copy: 'The agent answered but reports that it is unhealthy, because it can reach neither Docker nor ZFS. Check that the Docker socket or daemon on the agent host is running and mounted into the agent container, then check again.',
      showsDetail: false,
    },
    {
      code: 'certificate-rejected',
      status: 'unreachable',
      copy: "The manager rejected the agent's TLS certificate: it does not match the pinned one, has expired, or does not cover the host name in the URL. If the URL uses an address the certificate does not cover, change it to a host name the certificate does cover. Otherwise follow the agent TLS recovery steps in the self-hosting guide to enroll a fresh certificate, then check again.",
      showsDetail: true,
    },
    {
      code: 'health_check_failed',
      status: 'offline',
      copy: 'The host health check did not pass. Check the agent logs, then check again.',
      showsDetail: true,
    },
  ]

  for (const { code, status, copy, showsDetail } of FAILURE_COPY) {
    it(`renders the ${code} copy, ${showsDetail ? 'with' : 'without'} the probe detail`, async () => {
      const { AgentsOverviewView } = await import('@/components/agents/AgentsOverview')
      render(
        <AgentsOverviewView
          {...makeProps({
            agents: [makeAgent({ id: 2, name: 'media-server', status, failure: { code, message: 'raw probe detail 4521' } })],
          })}
        />,
      )
      expect(screen.getByText(copy)).toBeDefined()
      expect(screen.queryByText('raw probe detail 4521') !== null).toBe(showsDetail)
    })
  }

  it('shows the status badge label for an agent awaiting enrollment', async () => {
    const { AgentsOverviewView } = await import('@/components/agents/AgentsOverview')
    render(
      <AgentsOverviewView
        {...makeProps({
          agents: [makeAgent({ id: 2, status: 'awaiting-enrollment', failure: { code: 'awaiting-enrollment', message: '' } })],
        })}
      />,
    )
    expect(screen.getByText('Awaiting enrollment')).toBeDefined()
  })

  it('does not render a failure line for an online agent', async () => {
    const { AgentsOverviewView } = await import('@/components/agents/AgentsOverview')
    render(<AgentsOverviewView {...makeProps({ agents: [makeAgent()] })} />)
    expect(screen.queryByText(/then check again/)).toBeNull()
  })

  it('marks the version as stored for every agent that is not online, and never for one that is', async () => {
    const { AgentsOverviewView } = await import('@/components/agents/AgentsOverview')
    render(
      <AgentsOverviewView
        {...makeProps({
          agents: AGENT_INVENTORY_STATUSES.map((status, i) => makeAgent({ id: i + 1, name: `host-${status}`, status })),
        })}
      />,
    )
    for (const status of AGENT_INVENTORY_STATUSES) {
      const badge = within(screen.getByTestId(`agent-row-host-${status}`)).queryByLabelText('stored version')
      expect(badge === null, status).toBe(status === 'online')
    }
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

  it('renders the update-available warning with the apply guidance on that row and in a callout', async () => {
    const { AgentsOverviewView, AGENT_UPDATE_AVAILABLE_MESSAGE } = await import('@/components/agents/AgentsOverview')
    render(
      <AgentsOverviewView
        {...makeProps({
          agents: [makeAgent({ agentOutOfDate: true }), makeAgent({ id: 2, name: 'media-server' })],
        })}
      />,
    )
    expect(screen.getByLabelText('agent update available')).toBeDefined()
    expect(screen.getByTestId('agent-update-available-callout')).toBeDefined()
    expect(screen.getByText('Agent update available on 1 host')).toBeDefined()
    expect(screen.getByText(AGENT_UPDATE_AVAILABLE_MESSAGE)).toBeDefined()
    expect(screen.getByTestId('agent-row-media-server').textContent).not.toContain('update available')
  })

  it('renders no update warning when every agent is current', async () => {
    const { AgentsOverviewView } = await import('@/components/agents/AgentsOverview')
    render(
      <AgentsOverviewView
        {...makeProps({
          agents: [makeAgent(), makeAgent({ id: 2, name: 'media-server', agentOutOfDate: false })],
        })}
      />,
    )
    expect(screen.queryByLabelText('agent update available')).toBeNull()
    expect(screen.queryByTestId('agent-update-available-callout')).toBeNull()
  })

  it('renders the pinned update copy verbatim', async () => {
    const { AgentsOverviewView, AGENT_UPDATE_AVAILABLE_MESSAGE } = await import('@/components/agents/AgentsOverview')
    expect(AGENT_UPDATE_AVAILABLE_MESSAGE).toBe(
      'A newer agent image is available for this host. Select Update to apply it.',
    )
    render(<AgentsOverviewView {...makeProps({ agents: [makeAgent({ agentOutOfDate: true })] })} />)
    expect(screen.getByText(AGENT_UPDATE_AVAILABLE_MESSAGE)).toBeDefined()
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

  it('applies a live snapshot to the rendered rows', async () => {
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
    rejection.catch(() => {}) // handled by the component on click. The pre-catch silences the floating-rejection check.
    updateResult = rejection
    renderConnected()
    await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Update homeserver'))
    await waitFor(() => expect(screen.getByText('agent unreachable')).toBeDefined())
    expect(screen.getByTestId('agent-row-media-server').textContent).not.toContain('agent unreachable')
  })

  it('maps a failed update result to its code copy', async () => {
    updateResult = Promise.resolve({
      hostId: 1,
      healthy: false,
      code: 'offline',
      message: 'Health check timed out after 5000ms',
    })
    await renderConnected()
    await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Update homeserver'))
    await waitFor(() =>
      expect(screen.getByText(/The host did not answer the health check\./)).toBeDefined(),
    )
    expect(screen.getByTestId('agent-row-media-server').textContent).not.toContain('The host did not answer')
  })

  it('renders an agent route refusal by its own code where the generic sentence used to stand', async () => {
    updateResult = Promise.resolve({
      hostId: 1,
      healthy: false,
      code: 'update_in_progress',
      message: 'the guard rejected a second update',
    })
    await renderConnected()
    await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Update homeserver'))
    await waitFor(() =>
      expect(screen.getByText(/The agent started an update recently and is not accepting another yet\./)).toBeDefined(),
    )
    expect(screen.queryByText(/The agent refused the update\./)).toBeNull()
    expect(screen.getByTestId('agent-row-homeserver').textContent).not.toContain('the guard rejected a second update')
    expect(screen.getByTestId('agent-row-media-server').textContent).not.toContain('not accepting another yet')
  })

  it('keeps the generic refusal sentence and the agent detail when the refusal carries no route code', async () => {
    updateResult = Promise.resolve({
      hostId: 1,
      healthy: false,
      code: 'agent_reported_error',
      message: 'a refusal from an older agent',
    })
    await renderConnected()
    await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Update homeserver'))
    await waitFor(() =>
      expect(
        screen.getByText(
          'The agent refused the update. Correct the cause on the agent host, then retry the update. a refusal from an older agent',
        ),
      ).toBeDefined(),
    )
  })

  it('shows the stored cause of a pending host and an update refusal together on its row', async () => {
    inventoryResponse = [
      makeAgent({
        status: 'unreachable',
        version: null,
        versionSource: 'unknown',
        failure: { code: 'unreachable', message: 'stored cause 6120' },
      }),
    ]
    updateResult = Promise.resolve({
      hostId: 1,
      healthy: false,
      code: 'update_in_progress',
      message: 'the guard rejected a second update',
    })
    await renderConnected()
    await waitFor(() => expect(screen.getByText('Unreachable')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Update homeserver'))
    await waitFor(() =>
      expect(screen.getAllByText(/The agent started an update recently and is not accepting another yet\./)).toHaveLength(1),
    )
    expect(
      screen.getAllByText(
        'Something answered at the host URL, but it is not a healthy agent. Check that the URL stored for this host points at the agent, then check again.',
      ),
    ).toHaveLength(1)
    expect(screen.getAllByText('stored cause 6120')).toHaveLength(1)
    expect(screen.queryAllByText(/the guard rejected a second update/)).toHaveLength(0)
  })

  it('pins the fallback failure copy when the update mutation rejects with a non-Error', async () => {
    const rejection = Promise.reject('agent unreachable as raw string')
    rejection.catch(() => {}) // handled by the component on click. The pre-catch silences the floating-rejection check.
    updateResult = rejection
    renderConnected()
    await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Update homeserver'))
    await waitFor(() => expect(screen.getByText('Update failed')).toBeDefined())
  })

  it('pins the success copy when the update reports health without a version', async () => {
    updateResult = Promise.resolve({ hostId: 1, healthy: true })
    renderConnected()
    await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Update homeserver'))
    await waitFor(() => expect(screen.getByText('Update succeeded, agent is healthy')).toBeDefined())
  })

  it('blocks updates for non-admins', async () => {
    authState = { user: { id: 2, email: 'a@b.c', name: 'Viewer', role: 'viewer' }, loading: false, authEnabled: true }
    renderConnected()
    await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
    const updateButton = screen.getByLabelText('Update homeserver')
    expect(updateButton.hasAttribute('disabled')).toBe(true)
  })
})
