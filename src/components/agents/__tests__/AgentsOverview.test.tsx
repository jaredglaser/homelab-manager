import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { OPERATOR_DENIED_COPY, VIEWER_DENIED_COPY } from '@/hooks/useAuth'
import { findOpenTooltip, seedSession } from '@/lib/test/session'
import { setupUser } from '@/lib/test/user-event'
import type { AgentInventoryEntry, AgentInventoryFailure } from '@/lib/hosts/agent-inventory'
import { AGENT_INVENTORY_STATUSES, buildStoredAgentInventoryEntry } from '@/lib/hosts/agent-inventory'
import type { ManagedHost } from '@/lib/database/repositories/host-repository'

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
  update: null,
  checkedAt: '2026-09-25T23:00:00.000Z',
  ...overrides,
})

const makeStoredHost = (overrides?: Partial<ManagedHost>): ManagedHost => ({
  id: 1,
  name: 'homeserver',
  agentUrl: 'http://192.168.1.10:9090',
  capabilities: { docker: true },
  agentVersion: '0.2.0',
  agentImage: null,
  agentImageTag: null,
  agentImageDigest: null,
  agentOutOfDate: false,
  failure: null,
  status: 'healthy',
  createdAt: new Date('2026-09-25T00:00:00Z'),
  updatedAt: new Date('2026-09-25T00:00:00Z'),
  lastSweptAt: new Date('2026-09-25T23:00:00Z'),
  agentUpdate: null,
  ...overrides,
})

const noop = () => {}

function makeProps(overrides?: Partial<import('@/components/agents/AgentsOverview').AgentsOverviewProps>) {
  return {
    agents: [makeAgent()],
    isLoading: false,
    isError: false,
    busyByHost: {},
    feedbackByHost: {},
    onUpdate: mock(noop),
    onRetry: mock(noop),
    ...overrides,
  }
}

const ANSWERED_AT = '2026-11-27T10:00:00.000Z'
let inventoryResponse: AgentInventoryEntry[] = []
type OpResult = import('@/data/hosts/handlers').UpdateAgentResult
let updateResult: Promise<OpResult> = Promise.resolve({ hostId: 1, at: ANSWERED_AT, healthy: true, outcome: 'updated' })
let offContractResult: Promise<unknown> | null = null
let updateCalls: Array<{ data: { hostId: number } }> = []
const listAgentsInventory = (): Promise<AgentInventoryEntry[]> => Promise.resolve(inventoryResponse)
const updateAgent = (data: { data: { hostId: number } }) => {
  updateCalls.push(data)
  return offContractResult ?? updateResult
}

let sseHandler: ((snapshot: { entries: AgentInventoryEntry[] }) => void) | null = null

mock.module('@/lib/mux/use-mux-channel', () => ({
  useMuxChannel: (_channel: unknown, options: { onData: (data: { entries: AgentInventoryEntry[] }) => void }) => {
    sseHandler = options.onData
    return { isConnected: true, error: null }
  },
}))

const mockShowToast = mock<(message: string, severity: string) => void>()
void mock.module('@/hooks/toastAtom', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

mock.module('@/data/hosts/functions', () => ({
  listAgentsInventory: () => listAgentsInventory(),
  updateAgent: (data: { data: { hostId: number } }) => updateAgent(data),
}))

beforeEach(() => {
  seedSession('admin')
})

describe('AgentsOverviewView', () => {
  it('shows a loading state', async () => {
    const { AgentsOverviewView } = await import('@/components/agents/AgentsOverview')
    render(<AgentsOverviewView {...makeProps({ isLoading: true, agents: [] })} />)
    expect(screen.getByText('Loading hosts…')).toBeDefined()
  })

  it('shows an error state with a retry button', async () => {
    const { AgentsOverviewView } = await import('@/components/agents/AgentsOverview')
    const onRetry = mock(noop)
    render(<AgentsOverviewView {...makeProps({ isError: true, agents: [], onRetry })} />)
    expect(screen.getByText('Failed to load hosts')).toBeDefined()
    expect(screen.getByText('The host list could not be fetched. Check the server logs and try again.')).toBeDefined()
    fireEvent.click(screen.getByLabelText('Retry loading hosts'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('shows an empty state when no hosts are registered', async () => {
    const { AgentsOverviewView } = await import('@/components/agents/AgentsOverview')
    render(<AgentsOverviewView {...makeProps({ agents: [] })} />)
    expect(screen.getByText('No hosts registered')).toBeDefined()
    expect(screen.getByText('Add a host under Settings, then Managed Hosts, and it will appear here.')).toBeDefined()
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
    expect(screen.getByText('Agent v0.2.0')).toBeDefined()
    expect(screen.getByText('Agent v0.1.0')).toBeDefined()
    expect(screen.getAllByText('Update agent')).toHaveLength(2)
    expect(screen.getByTestId('agent-row-homeserver').querySelector('.lucide-server')).not.toBeNull()
    expect(screen.getByTestId('agent-row-homeserver').querySelector('.lucide-bot')).toBeNull()
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
      if (badge) expect(badge.textContent, status).toBe('stored')
    }
  })

  it('shows an online agent built from its stored row with its version and no stored badge', async () => {
    const { AgentsOverviewView } = await import('@/components/agents/AgentsOverview')
    const entry = buildStoredAgentInventoryEntry(makeStoredHost())
    expect(entry.status).toBe('online')
    render(<AgentsOverviewView {...makeProps({ agents: [entry] })} />)
    const row = screen.getByTestId('agent-row-homeserver')
    expect(within(row).getByText('Agent v0.2.0')).toBeDefined()
    expect(within(row).queryByLabelText('stored version')).toBeNull()
  })

  it('shows no version, and no stored badge, for a host that never reported one', async () => {
    const { AgentsOverviewView } = await import('@/components/agents/AgentsOverview')
    const agents = [
      buildStoredAgentInventoryEntry(makeStoredHost({ id: 1, name: 'enrolling', agentVersion: null, failure: { code: 'awaiting-enrollment', detail: null } })),
      buildStoredAgentInventoryEntry(makeStoredHost({ id: 2, name: 'broken', agentVersion: null, status: 'error', failure: { code: 'unreachable', detail: null } })),
    ]
    expect(agents.map((a) => a.status)).toEqual(['awaiting-enrollment', 'unreachable'])
    render(<AgentsOverviewView {...makeProps({ agents })} />)
    for (const name of ['enrolling', 'broken']) {
      const row = screen.getByTestId(`agent-row-${name}`)
      expect(within(row).getByText('Agent version unknown')).toBeDefined()
      expect(within(row).queryByLabelText('stored version')).toBeNull()
    }
  })

  it('pins the stored-version tooltip copy and shows it when the badge is hovered', async () => {
    const { AgentsOverviewView, AGENT_STORED_VERSION_MESSAGE } = await import('@/components/agents/AgentsOverview')
    expect(AGENT_STORED_VERSION_MESSAGE).toBe(
      'Last version the agent reported. It is not online right now, so this may be out of date.',
    )
    render(<AgentsOverviewView {...makeProps({ agents: [makeAgent({ status: 'offline' })] })} />)
    fireEvent.focus(screen.getByLabelText('stored version'))
    expect((await screen.findByText(AGENT_STORED_VERSION_MESSAGE)).textContent).toBe(AGENT_STORED_VERSION_MESSAGE)
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
    fireEvent.click(screen.getByLabelText('Update agent on media-server'))
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate).toHaveBeenCalledWith(2)
  })

  it.each([
    ['operator', OPERATOR_DENIED_COPY],
    ['viewer', VIEWER_DENIED_COPY],
  ] as const)('disables Update for the %s role with its reason, and a click calls nothing', async (role, copy) => {
    seedSession(role)
    const { AgentsOverviewView } = await import('@/components/agents/AgentsOverview')
    const onUpdate = mock(noop)
    render(<AgentsOverviewView {...makeProps({ onUpdate })} />)
    const user = setupUser()
    const updateButton = screen.getByLabelText('Update agent on homeserver')
    expect(updateButton.getAttribute('aria-disabled')).toBe('true')
    await user.click(updateButton)
    expect(await findOpenTooltip()).toBe(copy)
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
    expect(screen.getByLabelText('Update agent on homeserver').hasAttribute('disabled')).toBe(true)
    expect(screen.getByLabelText('Update agent on media-server').hasAttribute('disabled')).toBe(false)
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
    expect(screen.getByText('agent update available')).toBeDefined()
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
      'A newer agent image is available for this host. Select Update agent to apply it.',
    )
    render(<AgentsOverviewView {...makeProps({ agents: [makeAgent({ agentOutOfDate: true })] })} />)
    expect(screen.getByText(AGENT_UPDATE_AVAILABLE_MESSAGE)).toBeDefined()
  })
})

describe('AgentsOverview (connected)', () => {

  beforeEach(() => {
    inventoryResponse = [makeAgent(), makeAgent({ id: 2, name: 'media-server' })]
    updateResult = Promise.resolve({ hostId: 1, at: ANSWERED_AT, healthy: true, outcome: 'updated', version: '0.3.0' })
    offContractResult = null
    updateCalls = []
    mockShowToast.mockClear()
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

    await waitFor(() => expect(screen.getByText('Agent v9.9.9')).toBeDefined())
  })

  it('updates only the clicked agent and surfaces the result on that row', async () => {
    renderConnected()
    await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Update agent on homeserver'))
    await waitFor(() => expect(screen.getByText('Update confirmed, agent now on v0.3.0')).toBeDefined())
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0]).toEqual({ data: { hostId: 1 } })
    expect(screen.getByTestId('agent-row-media-server').textContent).not.toContain('Update confirmed')
  })

  describe('when the update call fails', () => {
    const NETWORK_COPY = "Couldn't reach the dashboard. Check your connection and try again."
    const FALLBACK_COPY = "Couldn't start the update. Reload the page and try again."
    let errorSpy: ReturnType<typeof spyOn<Console, 'error'>>

    beforeEach(() => {
      errorSpy = spyOn(console, 'error').mockImplementation(noop)
    })

    afterEach(() => {
      errorSpy.mockRestore()
    })

    async function rejectUpdateWith(err: unknown) {
      const rejection = Promise.reject(err)
      rejection.catch(() => {}) // handled by the component on click. The pre-catch silences the floating-rejection check.
      updateResult = rejection
      await renderConnected()
      await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
      fireEvent.click(screen.getByLabelText('Update agent on homeserver'))
    }

    function expectCopyOnRowAndToast(copy: string, rawText: string) {
      expect(within(screen.getByTestId('agent-row-homeserver')).getByText(copy)).toBeDefined()
      expect(mockShowToast).toHaveBeenCalledTimes(1)
      expect(mockShowToast).toHaveBeenCalledWith(copy, 'error')
      expect(document.body.textContent).not.toContain(rawText)
      expect(screen.getByTestId('agent-row-media-server').textContent).not.toContain(copy)
    }

    function expectLoggedOnce(err: unknown) {
      expect(errorSpy.mock.calls.filter((args) => args.includes(err))).toHaveLength(1)
    }

    it('shows the unreachable copy for a network failure and logs the error once', async () => {
      const err = new TypeError('Failed to fetch')
      await rejectUpdateWith(err)
      await waitFor(() => expect(mockShowToast).toHaveBeenCalled())
      expectCopyOnRowAndToast(NETWORK_COPY, 'Failed to fetch')
      expectLoggedOnce(err)
    })

    // Each arrives as Start delivers a server-side throw to the browser: a plain Error carrying only the message.
    it.each([
      ['a permission denial', 'Insufficient permissions'],
      ['an expired session', 'Unauthorized'],
      ['a missing host', 'Host with id 12 not found'],
    ])('shows the fallback copy for %s, never its raw text, and logs the error once', async (_label, text) => {
      const err = new Error(text)
      await rejectUpdateWith(err)
      await waitFor(() => expect(mockShowToast).toHaveBeenCalled())
      expectCopyOnRowAndToast(FALLBACK_COPY, text)
      expectLoggedOnce(err)
    })

    it.each([
      ['undefined', undefined],
      ['an unrelated JSON body', { message: 'Sign in to continue' }],
      ['a failure without a code', { healthy: false, message: 'Sign in to continue' }],
      ['a failure with a code this build does not know', { hostId: 1, healthy: false, code: 'code_from_a_newer_server', message: 'Sign in to continue' }],
    ])('shows the fallback copy when the call resolves to %s instead of an update result, and logs it once', async (_label, value) => {
      offContractResult = Promise.resolve(value)
      await renderConnected()
      await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
      fireEvent.click(screen.getByLabelText('Update agent on homeserver'))
      await waitFor(() => expect(mockShowToast).toHaveBeenCalled())
      expectCopyOnRowAndToast(FALLBACK_COPY, 'Sign in to continue')
      expect(document.body.textContent).not.toContain(NETWORK_COPY)
      const logged = errorSpy.mock.calls.filter(
        ([first]) => first instanceof Error && 'cause' in first && first.cause === value,
      )
      expect(logged).toHaveLength(1)
    })

    it('shows the fallback copy for a non-Error rejection and logs it once', async () => {
      const err = 'agent unreachable as raw string'
      await rejectUpdateWith(err)
      await waitFor(() => expect(mockShowToast).toHaveBeenCalled())
      expectCopyOnRowAndToast(FALLBACK_COPY, err)
      expectLoggedOnce(err)
    })
  })

  it('maps a failed update result to its code copy', async () => {
    updateResult = Promise.resolve({
      hostId: 1,
      at: ANSWERED_AT,
      healthy: false,
      code: 'offline',
      message: 'Health check timed out after 5000ms',
    })
    await renderConnected()
    await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Update agent on homeserver'))
    await waitFor(() =>
      expect(screen.getByText(/The host did not answer the health check\./)).toBeDefined(),
    )
    expect(screen.getByTestId('agent-row-media-server').textContent).not.toContain('The host did not answer')
    expect(mockShowToast).toHaveBeenCalledTimes(1)
    expect(mockShowToast.mock.calls[0]?.[0]).toMatch(/^The host did not answer the health check\./)
    expect(mockShowToast.mock.calls[0]?.[1]).toBe('error')
  })

  it('renders an agent route refusal by its own code where the generic sentence used to stand', async () => {
    updateResult = Promise.resolve({
      hostId: 1,
      at: ANSWERED_AT,
      healthy: false,
      code: 'update_in_progress',
      message: 'the guard rejected a second update',
    })
    await renderConnected()
    await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Update agent on homeserver'))
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
      at: ANSWERED_AT,
      healthy: false,
      code: 'agent_reported_error',
      message: 'a refusal from an older agent',
    })
    await renderConnected()
    await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Update agent on homeserver'))
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
        failure: { code: 'unreachable', message: 'stored cause 6120' },
      }),
    ]
    updateResult = Promise.resolve({
      hostId: 1,
      at: ANSWERED_AT,
      healthy: false,
      code: 'update_in_progress',
      message: 'the guard rejected a second update',
    })
    await renderConnected()
    await waitFor(() => expect(screen.getByText('Unreachable')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Update agent on homeserver'))
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

  it('pins the success copy when the update is confirmed by image digest without a new version', async () => {
    updateResult = Promise.resolve({ hostId: 1, at: ANSWERED_AT, healthy: true, outcome: 'updated' })
    renderConnected()
    await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Update agent on homeserver'))
    await waitFor(() => expect(screen.getByText('Update confirmed, agent restarted on the new image')).toBeDefined())
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('says nothing was changed when the agent already runs the latest image', async () => {
    updateResult = Promise.resolve({ hostId: 1, at: ANSWERED_AT, healthy: true, outcome: 'already_current' })
    renderConnected()
    await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Update agent on homeserver'))
    await waitFor(() => expect(screen.getByText('Already up to date. The agent runs the latest image, so nothing was changed.')).toBeDefined())
    expect(screen.queryByText(/Update (succeeded|confirmed)/)).toBeNull()
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('treats a healthy result without an outcome as off contract', async () => {
    offContractResult = Promise.resolve({ hostId: 1, healthy: true })
    renderConnected()
    await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Update agent on homeserver'))
    await waitFor(() => expect(mockShowToast).toHaveBeenCalled())
    expect(screen.queryByText(/Update (succeeded|confirmed)/)).toBeNull()
  })

  it('blocks updates for an operator, and a click sends nothing', async () => {
    seedSession('operator')
    renderConnected()
    await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
    const user = setupUser()
    const updateButton = screen.getByLabelText('Update agent on homeserver')
    expect(updateButton.getAttribute('aria-disabled')).toBe('true')
    await user.click(updateButton)
    expect(await findOpenTooltip()).toBe(OPERATOR_DENIED_COPY)
    expect(updateCalls).toEqual([])
  })
  describe('while an update runs in the background', () => {
    const W1 = 'Updating the agent. This takes up to a minute.'
    const W3 = 'An update is already running for this host. Wait for it to finish.'
    const W4 =
      "The dashboard restarted during this update, so its result was not recorded. Check the agent's version here, and update again if it did not change."
    const STARTED_AT = '2026-11-27T10:00:00.000Z'
    const ENDED_AT = '2026-11-27T10:00:40.000Z'
    const running = { state: 'running' as const, at: STARTED_AT }
    const media = makeAgent({ id: 2, name: 'media-server' })
    const row = () => screen.getByTestId('agent-row-homeserver')
    const button = () => screen.getByLabelText('Update agent on homeserver')

    function pushSnapshot(...entries: AgentInventoryEntry[]) {
      act(() => sseHandler!({ entries }))
    }

    it('pins the running and restart copy', async () => {
      const { AGENT_UPDATE_RUNNING_MESSAGE, AGENT_UPDATE_INTERRUPTED_MESSAGE } = await import('@/components/agents/AgentsOverview')
      expect(AGENT_UPDATE_RUNNING_MESSAGE).toBe(W1)
      expect(AGENT_UPDATE_INTERRUPTED_MESSAGE).toBe(W4)
    })

    it('shows the running message and turns the button off as soon as the update starts, then the result without a reload', async () => {
      updateResult = Promise.resolve({ hostId: 1, at: STARTED_AT, healthy: true, outcome: 'started' })
      await renderConnected()
      await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
      fireEvent.click(button())
      await waitFor(() => expect(within(row()).getByText(W1)).toBeDefined())
      expect(button().hasAttribute('disabled')).toBe(true)
      expect(screen.getByTestId('agent-row-media-server').textContent).not.toContain(W1)

      pushSnapshot(makeAgent({ update: running }), media)
      expect(within(row()).getByText(W1)).toBeDefined()

      pushSnapshot(
        makeAgent({ version: '0.3.0', update: { state: 'done', at: ENDED_AT, result: { healthy: true, outcome: 'updated', version: '0.3.0' } } }),
        media,
      )
      await waitFor(() => expect(within(row()).getByText('Update confirmed, agent now on v0.3.0')).toBeDefined())
      expect(within(row()).queryByText(W1)).toBeNull()
      expect(button().hasAttribute('disabled')).toBe(false)
      expect(updateCalls).toHaveLength(1)
      expect(mockShowToast).not.toHaveBeenCalled()
    })

    it('shows the running message with the button off after a reload during the update', async () => {
      inventoryResponse = [makeAgent({ update: running }), media]
      await renderConnected()
      await waitFor(() => expect(within(row()).getByText(W1)).toBeDefined())
      expect(button().hasAttribute('disabled')).toBe(true)
      expect(screen.getByLabelText('Update agent on media-server').hasAttribute('disabled')).toBe(false)
    })

    it('shows the result in a tab that did not start the update, without a toast', async () => {
      inventoryResponse = [makeAgent({ update: running }), media]
      await renderConnected()
      await waitFor(() => expect(within(row()).getByText(W1)).toBeDefined())
      pushSnapshot(
        makeAgent({ update: { state: 'done', at: ENDED_AT, result: { healthy: false, code: 'update_interrupted', message: 'old image' } } }),
        media,
      )
      await waitFor(() =>
        expect(within(row()).getByText('The agent is still running its previous image, so the update did not complete. Retry the update, and restart the agent container on the host if it repeats.')).toBeDefined(),
      )
      expect(mockShowToast).not.toHaveBeenCalled()
    })

    it('shows the row as usual after a reload once the update has ended', async () => {
      inventoryResponse = [
        makeAgent({ update: { state: 'done', at: ENDED_AT, result: { healthy: true, outcome: 'updated', version: '0.2.0' } } }),
        makeAgent({ id: 2, name: 'media-server', update: { state: 'interrupted', at: ENDED_AT } }),
      ]
      await renderConnected()
      await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
      expect(within(row()).getByText('Agent v0.2.0')).toBeDefined()
      expect(screen.queryByRole('status')).toBeNull()
      expect(button().hasAttribute('disabled')).toBe(false)
    })

    it('shows the restart message when the dashboard restarted during the update', async () => {
      inventoryResponse = [makeAgent({ update: running }), media]
      await renderConnected()
      await waitFor(() => expect(within(row()).getByText(W1)).toBeDefined())
      pushSnapshot(makeAgent({ update: { state: 'interrupted', at: ENDED_AT } }), media)
      await waitFor(() => expect(within(row()).getByText(W4)).toBeDefined())
      expect(button().hasAttribute('disabled')).toBe(false)
    })

    it('shows the already-running refusal on the row and in a toast, until the running update ends', async () => {
      updateResult = Promise.resolve({ hostId: 1, at: '2026-11-27T10:00:05.000Z', healthy: false, code: 'update_already_running', message: '' })
      await renderConnected()
      await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
      inventoryResponse = [makeAgent({ update: running }), media]
      fireEvent.click(button())
      await waitFor(() => expect(within(row()).getByText(W3)).toBeDefined())
      expect(mockShowToast).toHaveBeenCalledTimes(1)
      expect(mockShowToast).toHaveBeenCalledWith(W3, 'error')

      pushSnapshot(makeAgent({ update: running }), media)
      await waitFor(() => expect(button().hasAttribute('disabled')).toBe(true))
      expect(within(row()).getByText(W3)).toBeDefined()

      pushSnapshot(makeAgent({ update: { state: 'done', at: ENDED_AT, result: { healthy: true, outcome: 'updated' } } }), media)
      await waitFor(() => expect(within(row()).getByText('Update confirmed, agent restarted on the new image')).toBeDefined())
    })

    it('toasts a failed update once, in the tab that started it', async () => {
      updateResult = Promise.resolve({ hostId: 1, at: STARTED_AT, healthy: true, outcome: 'started' })
      await renderConnected()
      await waitFor(() => expect(screen.getByText('homeserver')).toBeDefined())
      fireEvent.click(button())
      await waitFor(() => expect(within(row()).getByText(W1)).toBeDefined())
      const failed = makeAgent({
        update: { state: 'done', at: ENDED_AT, result: { healthy: false, code: 'agent_did_not_restart', message: 'Agent did not restart after update' } },
      })
      const copy =
        'The agent did not come back after the update. Check that the agent container is running on the host, then retry the update. Agent did not restart after update'
      pushSnapshot(failed, media)
      await waitFor(() => expect(within(row()).getByText(copy)).toBeDefined())
      pushSnapshot(failed, media)
      await waitFor(() => expect(mockShowToast).toHaveBeenCalledTimes(1))
      expect(mockShowToast).toHaveBeenCalledWith(copy, 'error')
    })
  })
})
