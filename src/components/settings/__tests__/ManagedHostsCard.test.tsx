import { useState } from 'react'
import { describe, it, expect, mock } from 'bun:test'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { setupUser, activateWithKey, type TestUser } from '@/lib/test/user-event'
import { AgentChannelNotice, ManagedHostsCardView, bucketHostsByAgentChannel } from '@/components/settings/ManagedHostsCard'
import type { ManagedHostsCardProps } from '@/components/settings/ManagedHostsCard'
import type { HostListItem } from '@/lib/hosts/host-utils'

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

function makeProps(overrides?: Partial<ManagedHostsCardProps>): ManagedHostsCardProps {
  return {
    hosts: [],
    isLoading: false,
    isCreating: false,
    isProvisioning: false,
    createError: null,
    provisionError: null,
    pendingHost: {
      id: 1,
      name: 'server1',
      status: 'pending',
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'wizard-key-x' },
    },
    onCreateHost: mock(() => undefined),
    onVerify: mock(() => undefined),
    onCancelVerify: mock(() => undefined),
    onDiscard: mock(() => undefined),
    onRemove: mock(() => undefined),
    isRemoving: false,
    onUpdate: mock(() => Promise.resolve(true)),
    isUpdating: false,
    onHealthCheck: mock(() => undefined),
    checkingHostIds: new Set<number>(),
    onViewKeypair: mock(() => undefined),
    keypairLoading: false,
    onRotateKeypair: mock(() => undefined),
    keypairRotating: false,
    keypairJwkJson: null,
    onRotateTls: mock(() => undefined),
    rotatingTlsHostIds: new Set<number>(),
    ...overrides,
  }
}

// The Add Host wizard collects the host name on the first step and gates Next
// on it, so navigation tests must fill it before advancing.
async function enterHostName(user: TestUser, value = 'server1') {
  await user.type(screen.getByLabelText('Host Name'), value)
}

describe('ManagedHostsCard', () => {
  describe('loading state', () => {
    it('shows loading indicator when isLoading is true', () => {
      render(<ManagedHostsCardView {...makeProps({ isLoading: true })} />)
      expect(screen.getByText('Loading hosts…')).toBeDefined()
    })

    it('does not show host list when loading', () => {
      const host = makeHost()
      render(<ManagedHostsCardView {...makeProps({ isLoading: true, hosts: [host] })} />)
      expect(screen.queryByText('server1')).toBeNull()
    })
  })

  describe('empty state', () => {
    it('shows empty state message when no hosts', () => {
      render(<ManagedHostsCardView {...makeProps()} />)
      expect(screen.getByText(/No hosts configured/)).toBeDefined()
    })
  })

  describe('host list', () => {
    it('renders host name', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()] })} />)
      expect(screen.getByText('server1')).toBeDefined()
    })

    it('renders agent URL', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()] })} />)
      expect(screen.getByText('http://192.168.1.10:9090')).toBeDefined()
    })

    it('renders agent version', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()] })} />)
      expect(screen.getByText('v1.2.3')).toBeDefined()
    })

    it('does not render version when agentVersion is null', () => {
      const host = makeHost({ agentVersion: null })
      render(<ManagedHostsCardView {...makeProps({ hosts: [host] })} />)
      expect(screen.queryByText(/^v/)).toBeNull()
    })

    it('renders healthy status dot with aria-label', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost({ status: 'healthy' })] })} />)
      expect(screen.getByLabelText('healthy')).toBeDefined()
    })

    it('renders unhealthy status dot with aria-label', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost({ status: 'unhealthy' })] })} />)
      expect(screen.getByLabelText('unhealthy')).toBeDefined()
    })

    it('renders error status dot with aria-label', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost({ status: 'error' })] })} />)
      expect(screen.getByLabelText('error')).toBeDefined()
    })

    it('renders pending/unknown status dot with aria-label', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost({ status: 'pending' })] })} />)
      expect(screen.getByLabelText('unknown')).toBeDefined()
    })

    it('renders multiple hosts', () => {
      const hosts = [makeHost({ id: 1, name: 'server1' }), makeHost({ id: 2, name: 'server2' })]
      render(<ManagedHostsCardView {...makeProps({ hosts })} />)
      expect(screen.getByText('server1')).toBeDefined()
      expect(screen.getByText('server2')).toBeDefined()
    })

    it('renders capability chips for docker', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost({ capabilities: { docker: true } })] })} />)
      expect(screen.getAllByText('Docker').length).toBeGreaterThanOrEqual(1)
      // Chip is rendered inside the host row
      const chips = document.querySelectorAll('[data-slot="badge"]')
      expect(chips.length).toBeGreaterThanOrEqual(1)
    })

    it('renders capability chips for zfs', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost({ capabilities: { zfs: true } })] })} />)
      // ZFS chip in host row (wizard also has ZFS checkbox label)
      const chips = document.querySelectorAll('[data-slot="badge"]')
      const zfsChip = Array.from(chips).find((c) => c.textContent === 'ZFS')
      expect(zfsChip).toBeDefined()
    })

    it('renders the reported agent image tag as a chip', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost({ agentImageTag: 'latest' })] })} />)
      expect(screen.getByLabelText('agent image tag').textContent).toBe('latest')
    })

    it('renders no tag chip when the agent reported none', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost({ agentImage: null, agentImageTag: null })] })} />)
      expect(screen.queryByLabelText('agent image tag')).toBeNull()
    })

    it('marks an off-channel tag chip as a warning', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost({ agentImageTag: 'main' })] })} />)
      expect(screen.getByLabelText('agent image tag').className).toContain('bg-warning')
    })

    it('leaves an on-channel tag chip unstyled', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost({ agentImageTag: 'latest' })] })} />)
      expect(screen.getByLabelText('agent image tag').className).not.toContain('bg-warning')
    })

    it('renders both capability chips', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost({ capabilities: { docker: true, zfs: true } })] })} />)
      const chips = document.querySelectorAll('[data-slot="badge"]')
      const chipTexts = Array.from(chips).map((c) => c.textContent)
      expect(chipTexts).toContain('Docker')
      expect(chipTexts).toContain('ZFS')
    })
  })

  describe('health check', () => {
    it('calls onHealthCheck with host id when button clicked', async () => {
      const user = setupUser()
      const onHealthCheck = mock(() => undefined)
      render(
        <ManagedHostsCardView
          {...makeProps({ hosts: [makeHost()], onHealthCheck })}
        />
      )
      await user.click(screen.getByLabelText('check health'))
      expect(onHealthCheck).toHaveBeenCalledWith(1)
    })

    it('calls onHealthCheck with host id when the button is activated from the keyboard', async () => {
      const user = setupUser()
      const onHealthCheck = mock(() => undefined)
      render(
        <ManagedHostsCardView
          {...makeProps({ hosts: [makeHost()], onHealthCheck })}
        />
      )
      await activateWithKey(user, screen.getByLabelText('check health'), '{Enter}')
      expect(onHealthCheck).toHaveBeenCalledWith(1)
    })

    it('shows spinner when checkingHostIds contains host id', () => {
      render(
        <ManagedHostsCardView
          {...makeProps({ hosts: [makeHost()], checkingHostIds: new Set([1]) })}
        />
      )
      // The health check button should be disabled
      const btn = screen.getByLabelText('check health')
      expect(btn.hasAttribute('disabled')).toBe(true)
    })

    it('health check button is enabled when checkingHostIds does not contain host id', () => {
      render(
        <ManagedHostsCardView
          {...makeProps({ hosts: [makeHost({ id: 1 })], checkingHostIds: new Set([2]) })}
        />
      )
      const btn = screen.getByLabelText('check health')
      expect(btn.hasAttribute('disabled')).toBe(false)
    })
  })

  describe('remove host', () => {
    it('opens confirm dialog when remove button is clicked', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()] })} />)
      await user.click(screen.getByLabelText('remove host'))
      expect(screen.getByRole('dialog')).toBeDefined()
      expect(screen.getByRole('button', { name: 'Remove' })).toBeDefined()
    })

    it('shows host name in confirm dialog', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()] })} />)
      await user.click(screen.getByLabelText('remove host'))
      const dialog = screen.getByRole('dialog')
      expect(dialog.textContent).toContain('server1')
    })

    it('calls onRemove with host id after confirm', async () => {
      const user = setupUser()
      const onRemove = mock(() => undefined)
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()], onRemove })} />)
      await user.click(screen.getByLabelText('remove host'))
      // Click the confirm Remove button (color="error" button inside the dialog)
      const removeBtn = screen.getByRole('button', { name: 'Remove' })
      await user.click(removeBtn)
      expect(onRemove).toHaveBeenCalledWith(1)
    })

    it('does not call onRemove when Cancel is clicked', async () => {
      const user = setupUser()
      const onRemove = mock(() => undefined)
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()], onRemove })} />)
      await user.click(screen.getByLabelText('remove host'))
      await user.click(screen.getByText('Cancel'))
      expect(onRemove).not.toHaveBeenCalled()
    })

  })

  describe('add host wizard', () => {
    it('renders stepper with wizard steps', () => {
      render(<ManagedHostsCardView {...makeProps()} />)
      expect(screen.getByText('Capabilities')).toBeDefined()
    })

    it('renders capability checkboxes on first step', () => {
      render(<ManagedHostsCardView {...makeProps()} />)
      expect(screen.getByLabelText('Docker capability')).toBeDefined()
      expect(screen.getByLabelText('ZFS capability')).toBeDefined()
    })

    it('Next button advances to compose step (no ZFS)', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps()} />)
      // Docker is checked by default, ZFS is not, skip ZFS Setup
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-compose')).toBeDefined()
    })

    it('Next button advances to ZFS setup when ZFS is selected', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByLabelText('ZFS capability'))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-zfs-setup')).toBeDefined()
    })

    it('ZFS setup step shows UID/GID fields', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByLabelText('ZFS capability'))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByLabelText('HLM_ZFS_UID')).toBeDefined()
      expect(screen.getByLabelText('HLM_ZFS_GID')).toBeDefined()
    })

    it('ZFS setup shows DOCKER_GID when Docker is also selected', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByLabelText('ZFS capability'))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByLabelText('DOCKER_GID')).toBeDefined()
    })

    it('Next is disabled on capabilities step when no capability selected', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps()} />)
      await enterHostName(user)
      // Uncheck Docker (default checked)
      await user.click(screen.getByLabelText('Docker capability'))
      const nextBtn = screen.getByRole('button', { name: 'Next' })
      expect(nextBtn.hasAttribute('disabled')).toBe(true)
    })

    it('Next is disabled on capabilities step until a host name is entered', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps()} />)
      expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true)
      await enterHostName(user)
      expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(false)
    })

    it('compose step shows compose file content', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByText('docker-compose.yml')).toBeDefined()
    })

    it('verify step shows the agent host and port fields', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps()} />)
      await enterHostName(user)
      // Advance through capabilities -> compose -> configuration -> verify
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByLabelText('Agent host or IP')).toBeDefined()
      expect(screen.getByLabelText('Agent port')).toBeDefined()
    })

    it('Verify Connection button is disabled when the agent host is empty', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      const btn = screen.getByRole('button', { name: /Verify Connection/ })
      expect(btn.hasAttribute('disabled')).toBe(true)
    })

    it('Verify Connection button is enabled when fields are filled', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.type(screen.getByLabelText('Agent host or IP'), 'localhost')
      const btn = screen.getByRole('button', { name: /Verify Connection/ })
      expect(btn.hasAttribute('disabled')).toBe(false)
    })

    it('composes the plain-HTTP URL from host and port when Verify Connection is clicked', async () => {
      const user = setupUser()
      const onVerify = mock(() => undefined)
      render(<ManagedHostsCardView {...makeProps({ onVerify })} />)
      await enterHostName(user, '  server1  ')
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.type(screen.getByLabelText('Agent host or IP'), '  10.1.1.99  ')
      await user.clear(screen.getByLabelText('Agent port'))
      await user.type(screen.getByLabelText('Agent port'), '9191')
      await user.click(screen.getByRole('button', { name: /Verify Connection/ }))
      expect(onVerify).toHaveBeenCalledTimes(1)
      expect(onVerify).toHaveBeenCalledWith(1, 'http://10.1.1.99:9191')
    })

    it('Verify Connection button is disabled while isProvisioning', async () => {
      const user = setupUser()
      const { rerender } = render(<ManagedHostsCardView {...makeProps()} />)
      await enterHostName(user)
      // Navigate to verify step: capabilities -> compose -> configuration -> verify
      // The Next button is not disabled by isProvisioning, only Back and Verify are
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.type(screen.getByLabelText('Agent host or IP'), 'localhost')
      rerender(<ManagedHostsCardView {...makeProps({ isProvisioning: true })} />)
      const btn = screen.getByRole('button', { name: /Verifying/ })
      expect(btn.hasAttribute('disabled')).toBe(true)
    })

    it('shows the provisioning error with a re-run action on the verify step when provisionError is set', async () => {
      const user = setupUser()
      render(
        <ManagedHostsCardView {...makeProps({ provisionError: { message: 'Agent health check failed', retryUseless: false } })} />
      )
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByText('Agent health check failed')).toBeDefined()
      expect(screen.getByTestId('rerun-provisioning')).toBeDefined()
    })

    it('does not show an error when provisionError is null', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps({ provisionError: null })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-verify')).toBeDefined()
      expect(screen.queryByText('Agent health check failed')).toBeNull()
    })

    it('Back button goes to previous step', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-compose')).toBeDefined()
      await user.click(screen.getByRole('button', { name: 'Back' }))
      expect(screen.getByTestId('step-capabilities')).toBeDefined()
    })

    it('Reset button returns to first step', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Reset' }))
      expect(screen.getByTestId('step-capabilities')).toBeDefined()
    })

    it('references the key in the compose and puts the real key in the .env', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-compose').textContent).toContain('AGENT_TRUSTED_PUBKEY: ${AGENT_TRUSTED_PUBKEY}')
      expect(screen.getByTestId('step-compose').textContent).not.toContain('wizard-key-x')
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-env').textContent).toContain('wizard-key-x')
    })

    it('does not show the verify-step pubkey display: the key lives in the compose', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-verify')).toBeDefined()
      expect(screen.queryByTestId('pubkey-display')).toBeNull()
    })
  })

  describe('edit host', () => {
    it('renders edit host button per row', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()] })} />)
      expect(screen.getByLabelText('edit host')).toBeDefined()
    })

    it('opens edit dialog when edit button is clicked', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()] })} />)
      await user.click(screen.getByLabelText('edit host'))
      expect(screen.getByRole('dialog')).toBeDefined()
      expect(screen.getByLabelText('Edit Host Name')).toBeDefined()
    })

    it('pre-fills edit dialog with current host values', async () => {
      const user = setupUser()
      const host = makeHost({ name: 'myserver', agentUrl: 'http://10.0.0.1:9090' })
      render(<ManagedHostsCardView {...makeProps({ hosts: [host] })} />)
      await user.click(screen.getByLabelText('edit host'))
      expect((screen.getByLabelText('Edit Host Name') as HTMLInputElement).value).toBe('myserver')
      expect((screen.getByLabelText('Edit Agent URL') as HTMLInputElement).value).toBe('http://10.0.0.1:9090')
    })

    it('edit dialog does not have Socket Proxy URL field', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()] })} />)
      await user.click(screen.getByLabelText('edit host'))
      expect(screen.queryByLabelText('Edit Socket Proxy URL')).toBeNull()
    })

    it('calls onUpdate with the unchanged name and edited URL when Save is clicked', async () => {
      const user = setupUser()
      const onUpdate = mock(() => Promise.resolve(true))
      const host = makeHost()
      render(<ManagedHostsCardView {...makeProps({ hosts: [host], onUpdate })} />)
      await user.click(screen.getByLabelText('edit host'))
      await user.clear(screen.getByLabelText('Edit Agent URL'))
      await user.type(screen.getByLabelText('Edit Agent URL'), 'http://10.0.0.9:9090')
      await user.click(screen.getByRole('button', { name: 'Save' }))
      expect(onUpdate).toHaveBeenCalledWith(1, 'server1', 'http://10.0.0.9:9090')
    })

    it('does not call onUpdate when Cancel is clicked', async () => {
      const user = setupUser()
      const onUpdate = mock(() => Promise.resolve(true))
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()], onUpdate })} />)
      await user.click(screen.getByLabelText('edit host'))
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(onUpdate).not.toHaveBeenCalled()
    })

    it('Save button is disabled while isUpdating', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()], isUpdating: true })} />)
      await user.click(screen.getByLabelText('edit host'))
      // When isUpdating, the button shows CircularProgress instead of 'Save' text
      const dialog = screen.getByRole('dialog')
      const buttons = Array.from(dialog.querySelectorAll('button'))
      const saveBtn = buttons.find((b) => b !== screen.getByRole('button', { name: 'Cancel' }))
      expect(saveBtn).toBeDefined()
      expect(saveBtn!.hasAttribute('disabled')).toBe(true)
    })
  })

})

describe('ManagedHostsCard host actions', () => {
  const hosts = [
    makeHost({ id: 1, name: 'server1' }),
    makeHost({ id: 2, name: 'server2', agentUrl: 'http://192.168.1.11:9090' }),
  ]
  const confirmDialog = () => screen.getByRole('dialog')
  const dialogGone = () => waitFor(() => expect(screen.queryAllByRole('dialog').length).toBe(0))

  describe('per-row buttons act on their own host', () => {
    it('checks the health of the second host', async () => {
      const user = setupUser()
      const onHealthCheck = mock(() => undefined)
      render(<ManagedHostsCardView {...makeProps({ hosts, onHealthCheck })} />)
      await user.click(screen.getAllByLabelText('check health')[1])
      expect(onHealthCheck).toHaveBeenCalledTimes(1)
      expect(onHealthCheck).toHaveBeenCalledWith(2)
    })

    it('rotates TLS for the second host', async () => {
      const user = setupUser()
      const onRotateTls = mock(() => undefined)
      render(<ManagedHostsCardView {...makeProps({ hosts, onRotateTls })} />)
      await user.click(screen.getAllByLabelText('rotate TLS')[1])
      expect(onRotateTls).toHaveBeenCalledTimes(1)
      expect(onRotateTls).toHaveBeenCalledWith(2)
    })

    it('opens the keypair dialog for the second host and asks to load its key', async () => {
      const user = setupUser()
      const onViewKeypair = mock(() => undefined)
      render(<ManagedHostsCardView {...makeProps({ hosts, onViewKeypair, keypairJwkJson: '{"kty":"OKP","x":"abc"}', keypairFingerprint: 'AB:CD:EF' })} />)
      expect(screen.queryAllByRole('dialog').length).toBe(0)
      await user.click(screen.getAllByLabelText('agent keypair')[1])
      expect(within(confirmDialog()).getByText('Agent Keypair')).toBeDefined()
      expect(within(confirmDialog()).getByText('server2')).toBeDefined()
      expect(onViewKeypair).toHaveBeenCalledTimes(1)
      expect(onViewKeypair).toHaveBeenCalledWith(2)
      expect(screen.getByTestId('host-pubkey-display').textContent).toBe('{"kty":"OKP","x":"abc"}')
      expect(screen.getByTestId('host-fingerprint-display').textContent).toBe('AB:CD:EF')
    })

    it('rotates the keypair of the host whose dialog is open after the confirming click', async () => {
      const user = setupUser()
      const onRotateKeypair = mock(() => undefined)
      render(<ManagedHostsCardView {...makeProps({ hosts, onRotateKeypair, keypairJwkJson: '{"kty":"OKP","x":"abc"}' })} />)
      await user.click(screen.getAllByLabelText('agent keypair')[1])
      await user.click(screen.getByRole('button', { name: 'Rotate keypair' }))
      expect(onRotateKeypair).not.toHaveBeenCalled()
      await user.click(screen.getByRole('button', { name: 'Confirm rotation' }))
      expect(onRotateKeypair).toHaveBeenCalledTimes(1)
      expect(onRotateKeypair).toHaveBeenCalledWith(2)
    })

    it('disables the keypair dialog actions while the keypair rotates', async () => {
      const user = setupUser()
      const view = render(<ManagedHostsCardView {...makeProps({ hosts, keypairJwkJson: '{"kty":"OKP","x":"abc"}' })} />)
      await user.click(screen.getAllByLabelText('agent keypair')[0])
      expect(screen.getByRole('button', { name: 'Close' }).hasAttribute('disabled')).toBe(false)
      view.rerender(<ManagedHostsCardView {...makeProps({ hosts, keypairJwkJson: '{"kty":"OKP","x":"abc"}', keypairRotating: true })} />)
      expect(screen.getByRole('button', { name: 'Close' }).hasAttribute('disabled')).toBe(true)
    })

    it('shows the loading state in the keypair dialog while the key loads', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps({ hosts, keypairLoading: true })} />)
      await user.click(screen.getAllByLabelText('agent keypair')[0])
      expect(screen.getByText('Loading keypair…')).toBeDefined()
    })

    it('closes the keypair dialog with Close', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps({ hosts })} />)
      await user.click(screen.getAllByLabelText('agent keypair')[0])
      await user.click(screen.getByRole('button', { name: 'Close' }))
      await dialogGone()
    })

    it('opens the edit dialog for the second host and saves against its id', async () => {
      const user = setupUser()
      const onUpdate = mock(() => Promise.resolve(true))
      render(<ManagedHostsCardView {...makeProps({ hosts, onUpdate })} />)
      await user.click(screen.getAllByLabelText('edit host')[1])
      expect(screen.getByLabelText<HTMLInputElement>('Edit Host Name').value).toBe('server2')
      await user.click(screen.getByRole('button', { name: 'Save' }))
      expect(onUpdate).toHaveBeenCalledTimes(1)
      expect(onUpdate).toHaveBeenCalledWith(2, 'server2', 'http://192.168.1.11:9090')
    })

    it('confirms removal of the second host by name and removes its id', async () => {
      const user = setupUser()
      const onRemove = mock(() => undefined)
      render(<ManagedHostsCardView {...makeProps({ hosts, onRemove })} />)
      await user.click(screen.getAllByLabelText('remove host')[1])
      expect(within(confirmDialog()).getByText('server2')).toBeDefined()
      expect(within(confirmDialog()).queryAllByText('server1').length).toBe(0)
      await user.click(screen.getByRole('button', { name: 'Remove' }))
      expect(onRemove).toHaveBeenCalledTimes(1)
      expect(onRemove).toHaveBeenCalledWith(2)
    })
  })

  describe('row buttons while busy', () => {
    const labels = ['check health', 'edit host', 'agent keypair', 'rotate TLS', 'remove host']

    it('enables every row button when nothing is in flight', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()] })} />)
      for (const label of labels) expect(screen.getByLabelText(label).hasAttribute('disabled')).toBe(false)
    })

    it.each([
      ['a health check is running', { checkingHostIds: new Set([1]) }],
      ['a removal is running', { isRemoving: true }],
      ['a TLS rotation is running', { rotatingTlsHostIds: new Set([1]) }],
    ])('disables every button of the host while %s', (_label, overrides) => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()], ...overrides })} />)
      for (const label of labels) expect(screen.getByLabelText(label).hasAttribute('disabled')).toBe(true)
    })

    it.each([
      ['running a health check', { checkingHostIds: new Set([2]) }],
      ['rotating TLS', { rotatingTlsHostIds: new Set([2]) }],
    ])('leaves the other host\'s buttons enabled while the second host is %s', (_label, overrides) => {
      render(<ManagedHostsCardView {...makeProps({ hosts, ...overrides })} />)
      for (const label of labels) {
        const [first, second] = screen.getAllByLabelText(label)
        expect(first.hasAttribute('disabled')).toBe(false)
        expect(second.hasAttribute('disabled')).toBe(true)
      }
    })
  })

  describe('dialogs', () => {
    it('closes the remove dialog after Remove is confirmed', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()] })} />)
      await user.click(screen.getByLabelText('remove host'))
      await user.click(screen.getByRole('button', { name: 'Remove' }))
      await dialogGone()
    })

    it('closes the remove dialog with Cancel and with Escape', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()] })} />)
      await user.click(screen.getByLabelText('remove host'))
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      await dialogGone()
      await user.click(screen.getByLabelText('remove host'))
      expect(screen.getByRole('dialog')).toBeDefined()
      await user.keyboard('{Escape}')
      await dialogGone()
    })

    it('does not remove a host after the dialog was cancelled and reopened for another host', async () => {
      const user = setupUser()
      const onRemove = mock(() => undefined)
      render(<ManagedHostsCardView {...makeProps({ hosts, onRemove })} />)
      await user.click(screen.getAllByLabelText('remove host')[0])
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      await dialogGone()
      await user.click(screen.getAllByLabelText('remove host')[1])
      await user.click(screen.getByRole('button', { name: 'Remove' }))
      expect(onRemove).toHaveBeenCalledTimes(1)
      expect(onRemove).toHaveBeenCalledWith(2)
    })

    it('disables the remove dialog buttons while a removal is running', async () => {
      const user = setupUser()
      const view = render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()] })} />)
      await user.click(screen.getByLabelText('remove host'))
      expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(false)
      expect(screen.getByRole('button', { name: 'Remove' }).hasAttribute('disabled')).toBe(false)
      view.rerender(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()], isRemoving: true })} />)
      const cancelBtn = screen.getByRole('button', { name: 'Cancel' })
      expect(cancelBtn.hasAttribute('disabled')).toBe(true)
      const confirmBtn = within(confirmDialog()).getAllByRole('button').find((b) => b !== cancelBtn)!
      expect(confirmBtn.hasAttribute('disabled')).toBe(true)
    })

    it('closes the edit dialog with Cancel and with Escape', async () => {
      const user = setupUser()
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()] })} />)
      await user.click(screen.getByLabelText('edit host'))
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      await dialogGone()
      await user.click(screen.getByLabelText('edit host'))
      expect(screen.getByRole('dialog')).toBeDefined()
      await user.keyboard('{Escape}')
      await dialogGone()
    })

    it('keeps the edit dialog open while an update is running and disables its buttons', async () => {
      const user = setupUser()
      const view = render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()] })} />)
      await user.click(screen.getByLabelText('edit host'))
      view.rerender(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()], isUpdating: true })} />)
      expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true)
      expect(screen.getByLabelText<HTMLInputElement>('Edit Agent URL').disabled).toBe(true)
    })

    describe('after Save', () => {
      function pendingUpdate() {
        let settle: (saved: boolean) => void = () => undefined
        const result = new Promise<boolean>((resolve) => { settle = resolve })
        const onUpdate = mock<ManagedHostsCardProps['onUpdate']>(() => result)
        const finish = (saved: boolean) => act(() => Promise.resolve(settle(saved)))
        return { onUpdate, finish }
      }

      it('closes the edit dialog once the update succeeds, after a single onUpdate call', async () => {
        const user = setupUser()
        const { onUpdate, finish } = pendingUpdate()
        render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()], onUpdate })} />)
        await user.click(screen.getByLabelText('edit host'))
        await user.click(screen.getByRole('button', { name: 'Save' }))
        expect(screen.getAllByRole('dialog')).toHaveLength(1)
        await finish(true)
        await dialogGone()
        expect(onUpdate).toHaveBeenCalledTimes(1)
      })

      function PendingFlagCard({ onUpdate }: Readonly<{ onUpdate: ManagedHostsCardProps['onUpdate'] }>) {
        const [isUpdating, setIsUpdating] = useState(false)
        const trackedUpdate: ManagedHostsCardProps['onUpdate'] = async (hostId, name, agentUrl) => {
          setIsUpdating(true)
          try {
            return await onUpdate(hostId, name, agentUrl)
          } finally {
            setIsUpdating(false)
          }
        }
        return <ManagedHostsCardView {...makeProps({ hosts: [makeHost()], onUpdate: trackedUpdate, isUpdating })} />
      }

      it('ignores Escape and a backdrop click while the save is pending, then closes once it succeeds', async () => {
        const user = setupUser()
        const { onUpdate, finish } = pendingUpdate()
        render(<PendingFlagCard onUpdate={onUpdate} />)
        await user.click(screen.getByLabelText('edit host'))
        await user.click(screen.getByRole('button', { name: 'Save' }))
        expect(screen.getByLabelText<HTMLInputElement>('Edit Agent URL').disabled).toBe(true)

        await user.keyboard('{Escape}')
        const backdrops = document.querySelectorAll('[data-slot="dialog-backdrop"]')
        expect(backdrops).toHaveLength(1)
        await user.click(backdrops[0])
        expect(screen.getAllByRole('dialog')).toHaveLength(1)

        await finish(true)
        await dialogGone()
        expect(onUpdate).toHaveBeenCalledTimes(1)
      })

      it('lets Escape close the dialog again once a failed save clears the pending flag', async () => {
        const user = setupUser()
        const { onUpdate, finish } = pendingUpdate()
        render(<PendingFlagCard onUpdate={onUpdate} />)
        await user.click(screen.getByLabelText('edit host'))
        await user.click(screen.getByRole('button', { name: 'Save' }))
        await user.keyboard('{Escape}')
        expect(screen.getAllByRole('dialog')).toHaveLength(1)

        await finish(false)
        expect(screen.getByLabelText<HTMLInputElement>('Edit Agent URL').disabled).toBe(false)
        await user.keyboard('{Escape}')

        await dialogGone()
      })

      it('closes on success even while the pending flag is still set for that render', async () => {
        const user = setupUser()
        const { onUpdate, finish } = pendingUpdate()
        const view = render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()], onUpdate })} />)
        await user.click(screen.getByLabelText('edit host'))
        await user.click(screen.getByRole('button', { name: 'Save' }))
        view.rerender(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()], onUpdate, isUpdating: true })} />)
        await user.keyboard('{Escape}')
        expect(screen.getAllByRole('dialog')).toHaveLength(1)

        await finish(true)

        await dialogGone()
      })

      it('calls onUpdate once when Save is double-clicked before the update settles', async () => {
        const user = setupUser()
        const { onUpdate, finish } = pendingUpdate()
        render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()], onUpdate })} />)
        await user.click(screen.getByLabelText('edit host'))
        await user.dblClick(screen.getByRole('button', { name: 'Save' }))
        await finish(true)
        await dialogGone()
        expect(onUpdate).toHaveBeenCalledTimes(1)
      })

      it('keeps the edit dialog open with the edited URL when the update fails, and lets the user retry', async () => {
        const user = setupUser()
        const { onUpdate, finish } = pendingUpdate()
        render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()], onUpdate })} />)
        await user.click(screen.getByLabelText('edit host'))
        await user.clear(screen.getByLabelText('Edit Agent URL'))
        await user.type(screen.getByLabelText('Edit Agent URL'), 'http://10.0.0.9:9090')
        await user.click(screen.getByRole('button', { name: 'Save' }))
        await finish(false)
        expect(screen.getAllByRole('dialog')).toHaveLength(1)
        expect(screen.getByLabelText<HTMLInputElement>('Edit Agent URL').value).toBe('http://10.0.0.9:9090')
        onUpdate.mockImplementation(() => Promise.resolve(true))
        await user.click(screen.getByRole('button', { name: 'Save' }))
        await dialogGone()
        expect(onUpdate).toHaveBeenCalledTimes(2)
        expect(onUpdate).toHaveBeenLastCalledWith(1, 'server1', 'http://10.0.0.9:9090')
      })

      it('leaves the dialog of another host open when the first host\'s save finishes after the switch', async () => {
        const user = setupUser()
        const { onUpdate, finish } = pendingUpdate()
        render(<ManagedHostsCardView {...makeProps({ hosts, onUpdate })} />)
        await user.click(screen.getAllByLabelText('edit host')[0])
        await user.click(screen.getByRole('button', { name: 'Save' }))
        await user.keyboard('{Escape}')
        await dialogGone()
        await user.click(screen.getAllByLabelText('edit host')[1])
        await finish(true)
        expect(screen.getAllByRole('dialog')).toHaveLength(1)
        expect(screen.getByLabelText<HTMLInputElement>('Edit Host Name').value).toBe('server2')
        expect(onUpdate).toHaveBeenCalledTimes(1)
      })

      it('does not reopen or break anything when a save fails after the dialog was dismissed', async () => {
        const user = setupUser()
        const { onUpdate, finish } = pendingUpdate()
        render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()], onUpdate })} />)
        await user.click(screen.getByLabelText('edit host'))
        await user.click(screen.getByRole('button', { name: 'Save' }))
        await user.keyboard('{Escape}')
        await dialogGone()
        await finish(false)
        expect(screen.queryAllByRole('dialog')).toHaveLength(0)
      })

      it('keeps the edits and still closes on success when the host list refreshes while the dialog is open', async () => {
        const user = setupUser()
        const onUpdate = mock(() => Promise.resolve(true))
        const view = render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()], onUpdate })} />)
        await user.click(screen.getByLabelText('edit host'))
        await user.clear(screen.getByLabelText('Edit Agent URL'))
        await user.type(screen.getByLabelText('Edit Agent URL'), 'http://10.0.0.9:9090')
        view.rerender(<ManagedHostsCardView {...makeProps({ hosts: [makeHost({ updatedAt: '2024-02-01T00:00:00.000Z' })], onUpdate })} />)
        expect(screen.getByLabelText<HTMLInputElement>('Edit Agent URL').value).toBe('http://10.0.0.9:9090')
        await user.click(screen.getByRole('button', { name: 'Save' }))
        await dialogGone()
        expect(onUpdate).toHaveBeenCalledWith(1, 'server1', 'http://10.0.0.9:9090')
      })

      it('shows the host\'s current values when the dialog is reopened after a successful save', async () => {
        const user = setupUser()
        const onUpdate = mock(() => Promise.resolve(true))
        render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()], onUpdate })} />)
        await user.click(screen.getByLabelText('edit host'))
        await user.clear(screen.getByLabelText('Edit Agent URL'))
        await user.type(screen.getByLabelText('Edit Agent URL'), 'http://10.0.0.9:9090')
        await user.click(screen.getByRole('button', { name: 'Save' }))
        await dialogGone()
        await user.click(screen.getByLabelText('edit host'))
        expect(screen.getByLabelText<HTMLInputElement>('Edit Agent URL').value).toBe('http://192.168.1.10:9090')
      })
    })
  })

  describe('add host wizard hand-offs', () => {
    it('creates the pending host with the entered name and capabilities when Next reaches the Compose step', async () => {
      const user = setupUser()
      const onCreateHost = mock(() => undefined)
      render(<ManagedHostsCardView {...makeProps({ onCreateHost })} />)
      await enterHostName(user, 'newbox')
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(onCreateHost).toHaveBeenCalledTimes(1)
      expect(onCreateHost).toHaveBeenCalledWith('newbox', { docker: true, zfs: false })
    })

    it('discards the pending host when the wizard is reset', async () => {
      const user = setupUser()
      const onDiscard = mock(() => undefined)
      render(<ManagedHostsCardView {...makeProps({ onDiscard })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Reset' }))
      expect(onDiscard).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('step-capabilities')).toBeDefined()
    })

    it('cancels the verification when Cancel is clicked while provisioning', async () => {
      const user = setupUser()
      const onCancelVerify = mock(() => undefined)
      render(<ManagedHostsCardView {...makeProps({ onCancelVerify, isProvisioning: true })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-verify')).toBeDefined()
      await user.click(screen.getByTestId('cancel-provisioning'))
      expect(onCancelVerify).toHaveBeenCalledTimes(1)
    })

    it('passes the keypair failure state and the creation flags through to the wizard', async () => {
      const user = setupUser()
      const view = render(<ManagedHostsCardView {...makeProps({ pendingHost: null })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      view.rerender(<ManagedHostsCardView {...makeProps({ pendingHost: null, isCreating: true })} />)
      expect(screen.getByTestId('step-compose-loading')).toBeDefined()
      view.rerender(<ManagedHostsCardView {...makeProps({ pendingHost: null, createError: 'Failed to generate agent keypair: disk full' })} />)
      expect(screen.getByText('Failed to generate agent keypair: disk full')).toBeDefined()
    })
  })
})

describe('bucketHostsByAgentChannel', () => {
  it('splits hosts by reported tag', () => {
    const onChannel = makeHost({ id: 1, name: 'a', agentImageTag: '0.1' })
    const offChannel = makeHost({ id: 2, name: 'b', agentImageTag: 'main' })
    const silent = makeHost({ id: 3, name: 'c', agentImage: null, agentImageTag: null })

    const buckets = bucketHostsByAgentChannel([onChannel, offChannel, silent], '0.1')

    expect(buckets.mismatched.map((h) => h.name)).toEqual(['b'])
    expect(buckets.unreported.map((h) => h.name)).toEqual(['c'])
  })

  it.each(['pending', 'unhealthy', 'error'] as const)(
    'does not call a %s host unreported, since we never heard from it',
    (status) => {
      const host = makeHost({ id: 4, name: 'offline', agentImage: null, agentImageTag: null, status })
      const buckets = bucketHostsByAgentChannel([host], '0.1')
      expect(buckets.unreported).toEqual([])
      expect(buckets.mismatched).toEqual([])
    },
  )

  it('leaves a digest-pinned host out of both buckets', () => {
    const pinned = makeHost({
      id: 7,
      name: 'pinned',
      agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent@sha256:abc123',
      agentImageTag: null,
    })
    const buckets = bucketHostsByAgentChannel([pinned], '0.1')
    expect(buckets.unreported).toEqual([])
    expect(buckets.mismatched).toEqual([])
  })

  it.each([
    ['a malformed tag the agent could not parse', 'ghcr.io/x/agent:-bad'],
    ['an empty tag', 'ghcr.io/x/agent:'],
    ['a tag this app rejected as oversized', 'ghcr.io/x/agent:main'],
  ])('reports a host whose image is known but whose tag is not (%s)', (_label, image) => {
    const host = makeHost({ id: 8, name: 'untagged', agentImage: image, agentImageTag: null })
    const buckets = bucketHostsByAgentChannel([host], '0.1')
    expect(buckets.unreported.map((h) => h.name)).toEqual(['untagged'])
    expect(buckets.mismatched).toEqual([])
  })

  it('flags a main host against a 0.1 dashboard and the reverse', () => {
    const trunkHost = makeHost({ id: 5, name: 'devbox', agentImageTag: 'main' })
    expect(bucketHostsByAgentChannel([trunkHost], '0.1').mismatched).toHaveLength(1)
    expect(bucketHostsByAgentChannel([trunkHost], 'main').mismatched).toHaveLength(0)

    const releaseHost = makeHost({ id: 6, name: 'relbox', agentImageTag: '0.1' })
    expect(bucketHostsByAgentChannel([releaseHost], 'main').mismatched).toHaveLength(1)
  })
})

describe('agent channel notice', () => {
  const noticeProps = {
    expectedTag: '0.1',
    agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent:0.1',
    mismatched: [],
    unreported: [],
  }

  it('stays hidden when every host matches the default channel', () => {
    render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()] })} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('surfaces hosts on the wrong channel from the card', () => {
    const hosts = [makeHost({ id: 9, name: 'oddball', agentImage: 'ghcr.io/x/agent:main', agentImageTag: 'main' })]
    render(<ManagedHostsCardView {...makeProps({ hosts })} />)
    const alert = within(screen.getByRole('alert'))
    expect(alert.getByText('1 host is not on the latest channel')).toBeTruthy()
    expect(alert.getByText('oddball')).toBeTruthy()
    expect(alert.getByText('ghcr.io/x/agent:main')).toBeTruthy()
  })

  it('names the channel and the images new hosts get', () => {
    render(<AgentChannelNotice {...noticeProps} />)
    expect(screen.getByText('Agents pinned to the 0.1 channel')).toBeTruthy()
    expect(screen.getByText('ghcr.io/jaredglaser/homelab-manager-agent:0.1')).toBeTruthy()
  })

  it('lists each mismatched host with the image it actually runs', () => {
    const mismatched = [
      makeHost({ id: 1, name: 'alpha', agentImage: 'ghcr.io/x/agent:latest', agentImageTag: 'latest' }),
      makeHost({ id: 2, name: 'beta', agentImage: 'ghcr.io/x/agent:v0.9', agentImageTag: 'v0.9' }),
    ]
    render(<AgentChannelNotice {...noticeProps} mismatched={mismatched} />)
    expect(screen.getByText('2 hosts are not on the 0.1 channel')).toBeTruthy()
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('ghcr.io/x/agent:latest')).toBeTruthy()
    expect(screen.getByText('beta')).toBeTruthy()
    expect(screen.getByText('ghcr.io/x/agent:v0.9')).toBeTruthy()
  })

  it('tells the operator how to move already-enrolled hosts', () => {
    const mismatched = [makeHost({ agentImage: 'ghcr.io/x/agent:latest', agentImageTag: 'latest' })]
    render(<AgentChannelNotice {...noticeProps} mismatched={mismatched} />)
    expect(screen.getByText('AGENT_IMAGE')).toBeTruthy()
    expect(screen.getByText('docker compose up -d')).toBeTruthy()
  })

  it('calls out hosts that reported no usable tag', () => {
    const unreported = [makeHost({ id: 3, name: 'silent', agentImage: null, agentImageTag: null })]
    render(<AgentChannelNotice {...noticeProps} expectedTag="latest" unreported={unreported} />)
    expect(screen.getByText('1 host has not reported a usable image tag')).toBeTruthy()
    expect(screen.getByText(/No usable image tag from silent/)).toBeTruthy()
  })

  it('keeps naming unreported hosts on an off-default channel', () => {
    const unreported = [
      makeHost({ id: 3, name: 'silent', agentImage: null, agentImageTag: null }),
      makeHost({ id: 4, name: 'quiet', agentImage: null, agentImageTag: null }),
    ]
    render(<AgentChannelNotice {...noticeProps} unreported={unreported} />)
    expect(screen.getByText('2 hosts have not reported a usable image tag')).toBeTruthy()
    expect(screen.getByText(/No usable image tag from silent, quiet/)).toBeTruthy()
  })

  it('raises the alert to a warning only when a host is off-channel', () => {
    const { unmount } = render(<AgentChannelNotice {...noticeProps} />)
    expect(screen.getByRole('alert').className).not.toContain('--warning')
    unmount()

    render(<AgentChannelNotice {...noticeProps} mismatched={[makeHost({ agentImageTag: 'latest' })]} />)
    expect(screen.getByRole('alert').className).toContain('--warning')
  })

  it('surfaces an unreported host from the card, not just the notice', () => {
    const hosts = [makeHost({ id: 9, name: 'silent', agentImage: null, agentImageTag: null })]
    render(<ManagedHostsCardView {...makeProps({ hosts })} />)
    const alert = within(screen.getByRole('alert'))
    expect(alert.getByText('1 host has not reported a usable image tag')).toBeTruthy()
    expect(alert.getByText(/No usable image tag from silent/)).toBeTruthy()
  })

  it('shows no notice for a digest-pinned host on the default channel', () => {
    const hosts = [makeHost({ agentImage: 'ghcr.io/x/agent@sha256:abc', agentImageTag: null })]
    render(<ManagedHostsCardView {...makeProps({ hosts })} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
