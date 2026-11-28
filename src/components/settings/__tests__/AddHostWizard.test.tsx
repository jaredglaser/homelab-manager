import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { seedSession } from '@/lib/test/session'
import { render, screen, fireEvent } from '@testing-library/react'
import { setupUser, activateWithKey, type TestUser } from '@/lib/test/user-event'
import type { TlsFailureGuidance } from '@/lib/errors/tls-failure-copy'
import '@/lib/test/testing-library'
import AddHostWizard, { type PendingHostState } from '@/components/settings/AddHostWizard'

interface WizardProps {
  isCreating: boolean
  isProvisioning: boolean
  createError: string | null
  provisionError: TlsFailureGuidance | null
  pendingHost: PendingHostState | null
  onCreateHost: (name: string, capabilities: { docker: boolean; zfs: boolean }) => void
  onVerify: (hostId: number, agentUrl: string) => void
  onCancelVerify: () => void
  onDiscard: () => void
}

function makePendingHost(overrides?: Partial<PendingHostState>): PendingHostState {
  return {
    id: 1,
    name: 'dev-machine',
    status: 'pending',
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'wizard-key-x' },
    ...overrides,
  }
}

function makeProps(overrides?: Partial<WizardProps>): WizardProps {
  return {
    isCreating: false,
    isProvisioning: false,
    createError: null,
    provisionError: null,
    pendingHost: makePendingHost(),
    onCreateHost: mock(() => undefined),
    onVerify: mock(() => undefined),
    onCancelVerify: mock(() => undefined),
    onDiscard: mock(() => undefined),
    ...overrides,
  }
}

async function enterHostName(user: TestUser, value = 'dev-machine') {
  await user.type(screen.getByLabelText('Host Name'), value)
}

beforeEach(() => {
  seedSession('admin')
})

describe('AddHostWizard', () => {
  describe('initial render', () => {
    it('renders the Capabilities step by default', () => {
      render(<AddHostWizard {...makeProps()} />)
      expect(screen.getByTestId('step-capabilities')).toBeDefined()
    })

    it('shows the Host Name field on the Capabilities step', () => {
      render(<AddHostWizard {...makeProps()} />)
      expect(screen.getByLabelText('Host Name')).toBeDefined()
    })

    it('shows Docker and ZFS checkboxes', () => {
      render(<AddHostWizard {...makeProps()} />)
      expect(screen.getByLabelText('Docker capability')).toBeDefined()
      expect(screen.getByLabelText('ZFS capability')).toBeDefined()
    })

    it('Docker is checked by default', () => {
      render(<AddHostWizard {...makeProps()} />)
      const dockerCheckbox = screen.getByLabelText('Docker capability')
      expect(dockerCheckbox.getAttribute('aria-checked')).toBe('true')
    })

    it('ZFS is unchecked by default', () => {
      render(<AddHostWizard {...makeProps()} />)
      const zfsCheckbox = screen.getByLabelText('ZFS capability')
      expect(zfsCheckbox.getAttribute('aria-checked')).toBe('false')
    })

    it('Next is disabled until a host name is entered', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true)
      await enterHostName(user)
      expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(false)
    })

    it('shows stepper with correct steps (no ZFS)', () => {
      render(<AddHostWizard {...makeProps()} />)
      expect(screen.getByText('Capabilities')).toBeDefined()
      expect(screen.getByText('Compose File')).toBeDefined()
      expect(screen.getByText('Configuration')).toBeDefined()
      expect(screen.getByText('Verify Connection')).toBeDefined()
      expect(screen.queryByText('ZFS Setup')).toBeNull()
    })
  })

  describe('step navigation', () => {
    it('advances from Capabilities to Compose File when Next is clicked', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-compose')).toBeDefined()
    })

    it('advances from Capabilities to Compose File when Next is activated from the keyboard', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await activateWithKey(user, screen.getByRole('button', { name: 'Next' }), '{Enter}')
      expect(screen.getByTestId('step-compose')).toBeDefined()
    })

    it('creates the pending host when entering the Compose File step', async () => {
      const user = setupUser()
      const onCreateHost = mock(() => undefined)
      render(<AddHostWizard {...makeProps({ onCreateHost })} />)
      await enterHostName(user, '  dev-machine  ')
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(onCreateHost).toHaveBeenCalledWith('dev-machine', { docker: true, zfs: false })
    })

    it('creates the pending host with ZFS capabilities when leaving the ZFS Setup step', async () => {
      const user = setupUser()
      const onCreateHost = mock(() => undefined)
      render(<AddHostWizard {...makeProps({ onCreateHost })} />)
      await enterHostName(user)
      await user.click(screen.getByLabelText('ZFS capability'))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.type(screen.getByLabelText('HLM_ZFS_UID'), '1001')
      await user.type(screen.getByLabelText('HLM_ZFS_GID'), '1001')
      await user.type(screen.getByLabelText('DOCKER_GID'), '999')
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(onCreateHost).toHaveBeenCalledWith('dev-machine', { docker: true, zfs: true })
    })

    it('shows Back button after advancing past first step', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByRole('button', { name: 'Back' })).toBeDefined()
    })

    it('goes back to Capabilities when Back is clicked from Compose step', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Back' }))
      expect(screen.getByTestId('step-capabilities')).toBeDefined()
    })

    it('goes back to Capabilities when Back is activated from the keyboard', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await activateWithKey(user, screen.getByRole('button', { name: 'Back' }), '{Enter}')
      expect(screen.getByTestId('step-capabilities')).toBeDefined()
    })

    it('advances to Configuration from Compose File', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      // Capabilities → Compose
      await user.click(screen.getByRole('button', { name: 'Next' }))
      // Compose → Configuration
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-env')).toBeDefined()
    })

    it('advances to Verify Connection from Configuration', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      // Capabilities → Compose → Configuration → Verify
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-verify')).toBeDefined()
    })

    it('does not show Next button on Verify Connection step', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
    })
  })

  describe('ZFS step', () => {
    it('shows ZFS Setup step in stepper when ZFS is checked', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await user.click(screen.getByLabelText('ZFS capability'))
      expect(screen.getByText('ZFS Setup')).toBeDefined()
    })

    it('shows ZFS Setup content when navigating to that step with ZFS enabled', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByLabelText('ZFS capability'))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-zfs-setup')).toBeDefined()
    })

    it('Next is disabled on ZFS Setup step until UID and GID are filled', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByLabelText('ZFS capability'))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      const nextBtn = screen.getByRole('button', { name: 'Next' })
      expect(nextBtn.hasAttribute('disabled')).toBe(true)
    })

    it('Next is enabled on ZFS Setup once UID, GID, and Docker GID are filled', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      // Enable ZFS (Docker already checked)
      await user.click(screen.getByLabelText('ZFS capability'))
      // Go to ZFS Setup step
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.type(screen.getByLabelText('HLM_ZFS_UID'), '1001')
      await user.type(screen.getByLabelText('HLM_ZFS_GID'), '1001')
      await user.type(screen.getByLabelText('DOCKER_GID'), '999')
      const nextBtn = screen.getByRole('button', { name: 'Next' })
      expect(nextBtn.hasAttribute('disabled')).toBe(false)
    })

    it('does not show DOCKER_GID field when Docker is unchecked', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      // Uncheck Docker, check ZFS
      await user.click(screen.getByLabelText('Docker capability'))
      await user.click(screen.getByLabelText('ZFS capability'))
      // Go to ZFS Setup step
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-zfs-setup')).toBeDefined()
      expect(screen.getByLabelText('HLM_ZFS_UID')).toBeDefined()
      expect(screen.queryByLabelText('DOCKER_GID')).toBeNull()
    })
  })

  describe('Verify Connection step', () => {
    async function navigateToVerify(user: TestUser, name = 'dev-machine') {
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user, name)
      // Capabilities → Compose → Configuration → Verify
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
    }

    it('shows the agent host and port fields with the port defaulting to 9090', async () => {
      const user = setupUser()
      await navigateToVerify(user)
      expect(screen.getByLabelText('Agent host or IP')).toBeDefined()
      const port = screen.getByLabelText('Agent port') as HTMLInputElement
      expect(port.value).toBe('9090')
    })

    it('Verify Connection button is disabled when the host is empty', async () => {
      const user = setupUser()
      await navigateToVerify(user)
      const btn = screen.getByRole('button', { name: 'Verify Connection' })
      expect(btn.hasAttribute('disabled')).toBe(true)
    })

    it('Verify Connection button is enabled once the host is filled', async () => {
      const user = setupUser()
      await navigateToVerify(user)
      await user.type(screen.getByLabelText('Agent host or IP'), '192.168.1.10')
      const btn = screen.getByRole('button', { name: 'Verify Connection' })
      expect(btn.hasAttribute('disabled')).toBe(false)
    })

    it('Verify Connection button is disabled when the port is not a valid port', async () => {
      const user = setupUser()
      await navigateToVerify(user)
      await user.type(screen.getByLabelText('Agent host or IP'), '192.168.1.10')
      await user.clear(screen.getByLabelText('Agent port'))
      await user.type(screen.getByLabelText('Agent port'), '99999')
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(true)
      await user.clear(screen.getByLabelText('Agent port'))
      await user.type(screen.getByLabelText('Agent port'), 'abc')
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(true)
    })

    it('Next is disabled on the Compose step while the keypair has not been created', async () => {
      const user = setupUser()
      const view = render(<AddHostWizard {...makeProps({ pendingHost: null })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      // isCreating turns on only after the Next click lands (the create call), like the real flow.
      view.rerender(<AddHostWizard {...makeProps({ pendingHost: null, isCreating: true })} />)
      expect(screen.getByTestId('step-compose-loading')).toBeDefined()
      expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true)
    })

    it('composes a plain-HTTP URL from the host and port when Verify Connection is clicked', async () => {
      const user = setupUser()
      const onVerify = mock(() => undefined)
      render(<AddHostWizard {...makeProps({ onVerify })} />)
      await enterHostName(user, '  dev-machine  ')
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.type(screen.getByLabelText('Agent host or IP'), '  192.168.1.10  ')
      await user.clear(screen.getByLabelText('Agent port'))
      await user.type(screen.getByLabelText('Agent port'), '9191')
      await user.click(screen.getByRole('button', { name: 'Verify Connection' }))
      expect(onVerify).toHaveBeenCalledTimes(1)
      expect(onVerify).toHaveBeenCalledWith(1, 'http://192.168.1.10:9191')
    })

    it('calls onVerify when Verify Connection is activated from the keyboard', async () => {
      const user = setupUser()
      const onVerify = mock(() => undefined)
      render(<AddHostWizard {...makeProps({ onVerify })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.type(screen.getByLabelText('Agent host or IP'), '192.168.1.10')
      await activateWithKey(user, screen.getByRole('button', { name: 'Verify Connection' }), ' ')
      expect(onVerify).toHaveBeenCalledWith(1, 'http://192.168.1.10:9090')
    })

    it('accepts a bracketed IPv6 literal and keeps the brackets in the composed URL', async () => {
      const user = setupUser()
      const onVerify = mock(() => undefined)
      render(<AddHostWizard {...makeProps({ onVerify })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      // A doubled [[ is user-event keyboard escaping for a literal bracket.
      await user.type(screen.getByLabelText('Agent host or IP'), '[[2001:db8::1]')
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(false)
      await user.click(screen.getByRole('button', { name: 'Verify Connection' }))
      expect(onVerify).toHaveBeenCalledWith(1, 'http://[2001:db8::1]:9090')
    })

    it('still rejects a bare unbracketed IPv6 host whose colons cannot be a hostname', async () => {
      const user = setupUser()
      const onVerify = mock(() => undefined)
      render(<AddHostWizard {...makeProps({ onVerify })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.type(screen.getByLabelText('Agent host or IP'), '2001:db8::1')
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(true)
      await user.click(screen.getByRole('button', { name: 'Verify Connection' }))
      expect(onVerify).not.toHaveBeenCalled()
    })

    it('never produces an HTTPS URL, whatever the operator types', async () => {
      const user = setupUser()
      const onVerify = mock(() => undefined)
      render(<AddHostWizard {...makeProps({ onVerify })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      // A scheme typed into the host field is rejected as an invalid hostname.
      await user.type(screen.getByLabelText('Agent host or IP'), 'https://192.168.1.10')
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(true)
      await user.click(screen.getByRole('button', { name: 'Verify Connection' }))
      expect(onVerify).not.toHaveBeenCalled()
    })

    it('does not call onVerify when isProvisioning is true', async () => {
      const user = setupUser()
      const onVerify = mock(() => undefined)
      const { rerender } = render(<AddHostWizard {...makeProps({ onVerify })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.type(screen.getByLabelText('Agent host or IP'), '192.168.1.10')
      rerender(<AddHostWizard {...makeProps({ onVerify, isProvisioning: true })} />)
      const btn = screen.getByRole('button', { name: /Verifying/ })
      expect(btn.hasAttribute('disabled')).toBe(true)
      await user.click(btn)
      expect(onVerify).not.toHaveBeenCalled()
    })

    it('shows a Verifying loading state and a cancel action while provisioning', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps({ isProvisioning: true })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByRole('button', { name: /Verifying/ })).toBeDefined()
      expect(screen.queryByRole('button', { name: 'Verify Connection' })).toBeNull()
      expect(screen.getByTestId('cancel-provisioning')).toBeDefined()
    })

    it('cancel button calls onCancelVerify', async () => {
      const user = setupUser()
      const onCancelVerify = mock(() => undefined)
      render(<AddHostWizard {...makeProps({ onCancelVerify, isProvisioning: true })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByTestId('cancel-provisioning'))
      expect(onCancelVerify).toHaveBeenCalledTimes(1)
    })

    it('cancel button calls onCancelVerify when activated from the keyboard', async () => {
      const user = setupUser()
      const onCancelVerify = mock()
      render(<AddHostWizard {...makeProps({ onCancelVerify, isProvisioning: true })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await activateWithKey(user, screen.getByTestId('cancel-provisioning'), ' ')
      expect(onCancelVerify).toHaveBeenCalledTimes(1)
    })

    it('does not show a pubkey display on the verify step: the key lives in the compose', async () => {
      const user = setupUser()
      await navigateToVerify(user)
      expect(screen.getByTestId('step-verify')).toBeDefined()
      expect(screen.queryByTestId('pubkey-display')).toBeNull()
    })

    it('shows the provisioning error with a re-run provisioning action on failure', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps({ provisionError: { message: 'TLS provisioning failed: the agent did not become healthy over HTTPS.', retryUseless: false } })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('rerun-provisioning')).toBeDefined()
      expect(screen.getByText(/TLS provisioning failed/)).toBeDefined()
    })

    it('does not show the re-run action when there is no provisioning error', async () => {
      const user = setupUser()
      await navigateToVerify(user)
      expect(screen.getByTestId('step-verify')).toBeDefined()
      expect(screen.queryByTestId('rerun-provisioning')).toBeNull()
    })
  })

  describe('compose generation', () => {
    it('bakes the host name into AGENT_HOST_NAME in the compose snippet', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user, 'my-host')
      await user.click(screen.getByRole('button', { name: 'Next' }))
      const composeStep = screen.getByTestId('step-compose')
      expect(composeStep.textContent).toContain('AGENT_HOST_NAME: my-host')
    })

    it('bakes the trimmed host name into AGENT_HOST_NAME, the audience the agent matches against the managed host', async () => {
      const user = setupUser()
      const onCreateHost = mock(() => undefined)
      render(<AddHostWizard {...makeProps({ onCreateHost })} />)
      await enterHostName(user, '  my-host  ')
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(onCreateHost).toHaveBeenCalledWith('my-host', { docker: true, zfs: false })
      expect(screen.getByTestId('step-compose').textContent).toMatch(/AGENT_HOST_NAME: my-host$/m)
    })

    it('references the key in the compose without embedding it, and puts the real key in the .env', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      const composeStep = screen.getByTestId('step-compose')
      expect(composeStep.textContent).toContain('AGENT_TRUSTED_PUBKEY: ${AGENT_TRUSTED_PUBKEY}')
      expect(composeStep.textContent).not.toContain('wizard-key-x')
      expect(composeStep.textContent).not.toContain('"kty"')
      // Advance to Configuration: the .env carries the real key.
      await user.click(screen.getByRole('button', { name: 'Next' }))
      const envStep = screen.getByTestId('step-env')
      expect(envStep.textContent).toContain('AGENT_TRUSTED_PUBKEY={"kty":"OKP","crv":"Ed25519","x":"wizard-key-x"}')
    })

    it('shows a keypair spinner on the Compose step only while creation is in flight', async () => {
      const user = setupUser()
      const view = render(<AddHostWizard {...makeProps({ pendingHost: null })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      view.rerender(<AddHostWizard {...makeProps({ pendingHost: null, isCreating: true })} />)
      const loading = screen.getByTestId('step-compose-loading')
      expect(loading.textContent).toContain("Generating this host's keypair")
      expect(loading.querySelector('pre')).toBeNull()
    })

    it('shows an idle line on the Compose step when creation has not started', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps({ pendingHost: null })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByText('The keypair is generated when you reach this step.')).toBeDefined()
      expect(screen.queryByTestId('step-compose-loading')).toBeNull()
    })

    it('shows the create error without a spinner on the Compose step when creation failed', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps({ pendingHost: null, createError: 'Failed to generate agent keypair: disk full' })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByText(/Failed to generate agent keypair/)).toBeDefined()
      expect(screen.queryByTestId('step-compose-loading')).toBeNull()
    })
  })

  describe('error display', () => {
    it('shows the provisioning error with a re-run action on the verify step when provisionError is set', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps({ provisionError: { message: 'Connection refused', retryUseless: false } })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByText('Connection refused')).toBeDefined()
      expect(screen.getByTestId('rerun-provisioning')).toBeDefined()
    })

    it('links the runbook recovery steps when the failure names a section', async () => {
      const user = setupUser()
      render(
        <AddHostWizard
          {...makeProps({
            provisionError: {
              message: 'No pinned certificate for this host.',
              retryUseless: true,
              docAnchor: 'agent-tls-recovery-the-manager-lost-it',
            },
          })}
        />,
      )
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByText('No pinned certificate for this host.')).toBeDefined()
      expect(screen.getByRole('link', { name: 'TLS recovery steps' }).getAttribute('href')).toBe(
        'https://github.com/jaredglaser/homelab-manager/blob/main/self-hosting/README.md#agent-tls-recovery-the-manager-lost-it',
      )
    })

    it('does not show an error alert when createError and provisionError are null', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-verify')).toBeDefined()
      expect(screen.queryByRole('alert')).toBeNull()
    })
  })

  describe('Reset', () => {
    it('resets back to Capabilities step', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      // Advance to Compose File
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-compose')).toBeDefined()
      // Reset
      await user.click(screen.getByRole('button', { name: 'Reset' }))
      expect(screen.getByTestId('step-capabilities')).toBeDefined()
    })

    it('discards the pending host on reset', async () => {
      const user = setupUser()
      const onDiscard = mock(() => undefined)
      render(<AddHostWizard {...makeProps({ onDiscard })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Reset' }))
      expect(onDiscard).toHaveBeenCalledTimes(1)
    })

    it('discards the pending host when Reset is activated from the keyboard', async () => {
      const user = setupUser()
      const onDiscard = mock()
      render(<AddHostWizard {...makeProps({ onDiscard })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await activateWithKey(user, screen.getByRole('button', { name: 'Reset' }), '{Enter}')
      expect(onDiscard).toHaveBeenCalledTimes(1)
    })

    it('clears the host name on reset', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user, 'dev-machine')
      await user.click(screen.getByRole('button', { name: 'Reset' }))
      expect((screen.getByLabelText('Host Name') as HTMLInputElement).value).toBe('')
    })

    it('resets ZFS checkbox to unchecked', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await user.click(screen.getByLabelText('ZFS capability'))
      expect(screen.getByLabelText('ZFS capability').getAttribute('aria-checked')).toBe('true')
      await user.click(screen.getByRole('button', { name: 'Reset' }))
      expect(screen.getByLabelText('ZFS capability').getAttribute('aria-checked')).toBe('false')
    })

    it('resets Docker back to checked', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await user.click(screen.getByLabelText('Docker capability'))
      expect(screen.getByLabelText('Docker capability').getAttribute('aria-checked')).toBe('false')
      await user.click(screen.getByRole('button', { name: 'Reset' }))
      expect(screen.getByLabelText('Docker capability').getAttribute('aria-checked')).toBe('true')
    })

    it('clears the ZFS UID, GID and Docker GID', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByLabelText('ZFS capability'))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.type(screen.getByLabelText('HLM_ZFS_UID'), '1001')
      await user.type(screen.getByLabelText('HLM_ZFS_GID'), '1002')
      await user.type(screen.getByLabelText('DOCKER_GID'), '999')
      await user.click(screen.getByRole('button', { name: 'Reset' }))
      await enterHostName(user)
      await user.click(screen.getByLabelText('ZFS capability'))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-zfs-setup')).toBeDefined()
      expect(screen.getByLabelText<HTMLInputElement>('HLM_ZFS_UID').value).toBe('')
      expect(screen.getByLabelText<HTMLInputElement>('HLM_ZFS_GID').value).toBe('')
      expect(screen.getByLabelText<HTMLInputElement>('DOCKER_GID').value).toBe('')
    })

    it('clears the agent host and restores the default port', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.type(screen.getByLabelText('Agent host or IP'), '10.0.0.5')
      await user.clear(screen.getByLabelText('Agent port'))
      await user.type(screen.getByLabelText('Agent port'), '8080')
      await user.click(screen.getByRole('button', { name: 'Reset' }))
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-verify')).toBeDefined()
      expect(screen.getByLabelText<HTMLInputElement>('Agent host or IP').value).toBe('')
      expect(screen.getByLabelText<HTMLInputElement>('Agent port').value).toBe('9090')
    })

    it('Reset button is disabled while creating or provisioning', () => {
      render(<AddHostWizard {...makeProps({ isCreating: true })} />)
      const resetBtn = screen.getByRole('button', { name: 'Reset' })
      expect(resetBtn.hasAttribute('disabled')).toBe(true)
    })
  })

  describe('input validation', () => {
    const nextButton = () => screen.getByRole('button', { name: 'Next' })
    const verifyButton = () => screen.getByRole('button', { name: 'Verify Connection' })

    async function advanceToVerify(user: TestUser) {
      await user.click(nextButton())
      await user.click(nextButton())
      await user.click(nextButton())
      expect(screen.getByTestId('step-verify')).toBeDefined()
    }

    async function openZfsStep(user: TestUser, options: { docker: boolean } = { docker: true }) {
      await enterHostName(user)
      if (!options.docker) await user.click(screen.getByLabelText('Docker capability'))
      await user.click(screen.getByLabelText('ZFS capability'))
      await user.click(nextButton())
      expect(screen.getByTestId('step-zfs-setup')).toBeDefined()
    }

    it('keeps Next disabled for a whitespace-only host name', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await user.type(screen.getByLabelText('Host Name'), '   ')
      expect(nextButton().hasAttribute('disabled')).toBe(true)
    })

    it('keeps Next disabled when neither Docker nor ZFS is selected', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      expect(nextButton().hasAttribute('disabled')).toBe(false)
      await user.click(screen.getByLabelText('Docker capability'))
      expect(nextButton().hasAttribute('disabled')).toBe(true)
      await user.click(screen.getByLabelText('ZFS capability'))
      expect(nextButton().hasAttribute('disabled')).toBe(false)
    })

    it('requires HLM_ZFS_UID on the ZFS step', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await openZfsStep(user)
      await user.type(screen.getByLabelText('HLM_ZFS_GID'), '1001')
      await user.type(screen.getByLabelText('DOCKER_GID'), '999')
      expect(nextButton().hasAttribute('disabled')).toBe(true)
    })

    it('requires HLM_ZFS_GID on the ZFS step', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await openZfsStep(user)
      await user.type(screen.getByLabelText('HLM_ZFS_UID'), '1001')
      await user.type(screen.getByLabelText('DOCKER_GID'), '999')
      expect(nextButton().hasAttribute('disabled')).toBe(true)
    })

    it('requires DOCKER_GID on the ZFS step when Docker is selected', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await openZfsStep(user)
      await user.type(screen.getByLabelText('HLM_ZFS_UID'), '1001')
      await user.type(screen.getByLabelText('HLM_ZFS_GID'), '1001')
      expect(nextButton().hasAttribute('disabled')).toBe(true)
      await user.type(screen.getByLabelText('DOCKER_GID'), '999')
      expect(nextButton().hasAttribute('disabled')).toBe(false)
    })

    it('needs only HLM_ZFS_UID and HLM_ZFS_GID on the ZFS step when Docker is not selected', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await openZfsStep(user, { docker: false })
      await user.type(screen.getByLabelText('HLM_ZFS_UID'), '1001')
      expect(nextButton().hasAttribute('disabled')).toBe(true)
      await user.type(screen.getByLabelText('HLM_ZFS_GID'), '1001')
      expect(nextButton().hasAttribute('disabled')).toBe(false)
    })

    it.each(['HLM_ZFS_UID', 'HLM_ZFS_GID', 'DOCKER_GID'])('rejects a negative or fractional value in %s', async (field) => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await openZfsStep(user)
      const fill = async (name: string, value: string) => {
        await user.clear(screen.getByLabelText(name))
        await user.type(screen.getByLabelText(name), value)
      }
      for (const name of ['HLM_ZFS_UID', 'HLM_ZFS_GID', 'DOCKER_GID']) await fill(name, '1001')
      expect(nextButton().hasAttribute('disabled')).toBe(false)
      for (const bad of ['-1', '1.5']) {
        await fill(field, bad)
        expect(nextButton().hasAttribute('disabled')).toBe(true)
      }
      await fill(field, '0')
      expect(nextButton().hasAttribute('disabled')).toBe(false)
    })

    it.each(['HLM_ZFS_UID', 'HLM_ZFS_GID', 'DOCKER_GID'])('accepts a value padded with whitespace in %s', async (field) => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await openZfsStep(user)
      for (const name of ['HLM_ZFS_UID', 'HLM_ZFS_GID', 'DOCKER_GID']) await user.type(screen.getByLabelText(name), '1001')
      expect(nextButton().hasAttribute('disabled')).toBe(false)
      fireEvent.change(screen.getByLabelText(field), { target: { value: '1001 ' } })
      expect(nextButton().hasAttribute('disabled')).toBe(false)
      fireEvent.change(screen.getByLabelText(field), { target: { value: ' ' } })
      expect(nextButton().hasAttribute('disabled')).toBe(true)
    })

    it('keeps Next disabled on the Compose step until the keypair exists, even when nothing is in flight', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps({ pendingHost: null })} />)
      await enterHostName(user)
      await user.click(nextButton())
      expect(screen.getByText('The keypair is generated when you reach this step.')).toBeDefined()
      expect(nextButton().hasAttribute('disabled')).toBe(true)
    })

    it('keeps Next disabled on the Compose step while the keypair is being created, even though one exists', async () => {
      const user = setupUser()
      const view = render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await user.click(nextButton())
      expect(nextButton().hasAttribute('disabled')).toBe(false)
      view.rerender(<AddHostWizard {...makeProps({ isCreating: true })} />)
      expect(screen.getByTestId('step-compose-loading')).toBeDefined()
      expect(nextButton().hasAttribute('disabled')).toBe(true)
    })

    it('disables Back while the keypair is being created', async () => {
      const user = setupUser()
      const view = render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await user.click(nextButton())
      expect(screen.getByRole('button', { name: 'Back' }).hasAttribute('disabled')).toBe(false)
      view.rerender(<AddHostWizard {...makeProps({ isCreating: true })} />)
      expect(screen.getByRole('button', { name: 'Back' }).hasAttribute('disabled')).toBe(true)
    })

    it('disables Back and Reset while provisioning', async () => {
      const user = setupUser()
      const view = render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await advanceToVerify(user)
      expect(screen.getByRole('button', { name: 'Back' }).hasAttribute('disabled')).toBe(false)
      expect(screen.getByRole('button', { name: 'Reset' }).hasAttribute('disabled')).toBe(false)
      view.rerender(<AddHostWizard {...makeProps({ isProvisioning: true })} />)
      expect(screen.getByRole('button', { name: 'Back' }).hasAttribute('disabled')).toBe(true)
      expect(screen.getByRole('button', { name: 'Reset' }).hasAttribute('disabled')).toBe(true)
    })

    it.each([
      ['0', true],
      ['1', false],
      ['65535', false],
      ['65536', true],
      ['80.5', true],
      ['', true],
    ])('port %p disables Verify Connection: %p', async (port, disabled) => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await advanceToVerify(user)
      await user.type(screen.getByLabelText('Agent host or IP'), '192.168.1.10')
      await user.clear(screen.getByLabelText('Agent port'))
      if (port) await user.type(screen.getByLabelText('Agent port'), port)
      expect(verifyButton().hasAttribute('disabled')).toBe(disabled)
    })

    it.each(['host name', 'host/path', 'host:9090', '[zzz]', '[2001:db8::1', '2001:db8::1]'])('keeps Verify Connection disabled for the invalid host %p', async (host) => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await advanceToVerify(user)
      await user.type(screen.getByLabelText('Agent host or IP'), host.replaceAll('[', '[['))
      expect(verifyButton().hasAttribute('disabled')).toBe(true)
    })

    it.each(['localhost', 'nas.home.lan', 'my_host-2', '10.0.0.5', '[::1]'])('enables Verify Connection for the valid host %p', async (host) => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await advanceToVerify(user)
      await user.type(screen.getByLabelText('Agent host or IP'), host.replaceAll('[', '[['))
      expect(verifyButton().hasAttribute('disabled')).toBe(false)
    })

    it('keeps Verify Connection disabled for a whitespace-only host', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await advanceToVerify(user)
      await user.type(screen.getByLabelText('Agent host or IP'), '   ')
      expect(verifyButton().hasAttribute('disabled')).toBe(true)
    })

    it('keeps Verify Connection disabled and calls nothing once the pending host is gone', async () => {
      const user = setupUser()
      const onVerify = mock(() => undefined)
      const view = render(<AddHostWizard {...makeProps({ onVerify })} />)
      await enterHostName(user)
      await advanceToVerify(user)
      await user.type(screen.getByLabelText('Agent host or IP'), '192.168.1.10')
      expect(verifyButton().hasAttribute('disabled')).toBe(false)
      view.rerender(<AddHostWizard {...makeProps({ onVerify, pendingHost: null })} />)
      expect(verifyButton().hasAttribute('disabled')).toBe(true)
      await user.click(verifyButton())
      expect(onVerify).not.toHaveBeenCalled()
    })

    it('verifies the pending host it was given, once the Compose step has created it', async () => {
      const user = setupUser()
      const onVerify = mock(() => undefined)
      const onCreateHost = mock(() => undefined)
      render(<AddHostWizard {...makeProps({ onVerify, onCreateHost, pendingHost: makePendingHost({ id: 42 }) })} />)
      await enterHostName(user)
      await advanceToVerify(user)
      expect(onCreateHost).toHaveBeenCalledTimes(1)
      await user.type(screen.getByLabelText('Agent host or IP'), '192.168.1.10')
      await user.click(verifyButton())
      expect(onVerify).toHaveBeenCalledWith(42, 'http://192.168.1.10:9090')
    })

    describe('Re-run provisioning', () => {
      const failure = { message: 'Connection refused', retryUseless: false }

      async function openFailedVerify(user: TestUser, onVerify: ReturnType<typeof mock>) {
        const view = render(<AddHostWizard {...makeProps({ onVerify, provisionError: failure })} />)
        await enterHostName(user)
        await advanceToVerify(user)
        return view
      }

      it('calls onVerify with the composed URL when clicked', async () => {
        const user = setupUser()
        const onVerify = mock(() => undefined)
        await openFailedVerify(user, onVerify)
        await user.type(screen.getByLabelText('Agent host or IP'), '192.168.1.10')
        await user.click(screen.getByTestId('rerun-provisioning'))
        expect(onVerify).toHaveBeenCalledTimes(1)
        expect(onVerify).toHaveBeenCalledWith(1, 'http://192.168.1.10:9090')
      })

      it('does nothing while the agent host is empty', async () => {
        const user = setupUser()
        const onVerify = mock(() => undefined)
        await openFailedVerify(user, onVerify)
        await user.click(screen.getByTestId('rerun-provisioning'))
        expect(onVerify).not.toHaveBeenCalled()
      })

      it('does nothing while the agent port is invalid', async () => {
        const user = setupUser()
        const onVerify = mock(() => undefined)
        await openFailedVerify(user, onVerify)
        await user.type(screen.getByLabelText('Agent host or IP'), '192.168.1.10')
        await user.clear(screen.getByLabelText('Agent port'))
        await user.type(screen.getByLabelText('Agent port'), '99999')
        await user.click(screen.getByTestId('rerun-provisioning'))
        expect(onVerify).not.toHaveBeenCalled()
      })

      it('does nothing once the pending host is gone', async () => {
        const user = setupUser()
        const onVerify = mock(() => undefined)
        const view = await openFailedVerify(user, onVerify)
        await user.type(screen.getByLabelText('Agent host or IP'), '192.168.1.10')
        view.rerender(<AddHostWizard {...makeProps({ onVerify, provisionError: failure, pendingHost: null })} />)
        await user.click(screen.getByTestId('rerun-provisioning'))
        expect(onVerify).not.toHaveBeenCalled()
      })

      it('is disabled while provisioning', async () => {
        const user = setupUser()
        const onVerify = mock(() => undefined)
        const view = await openFailedVerify(user, onVerify)
        await user.type(screen.getByLabelText('Agent host or IP'), '192.168.1.10')
        view.rerender(<AddHostWizard {...makeProps({ onVerify, provisionError: failure, isProvisioning: true })} />)
        expect(screen.getByTestId('rerun-provisioning').hasAttribute('disabled')).toBe(true)
        await user.click(screen.getByTestId('rerun-provisioning'))
        expect(onVerify).not.toHaveBeenCalled()
      })
    })

    describe('Verify step while provisioning', () => {
      it('disables both agent fields and shows Cancel only while provisioning', async () => {
        const user = setupUser()
        const view = render(<AddHostWizard {...makeProps()} />)
        await enterHostName(user)
        await advanceToVerify(user)
        expect(screen.getByLabelText<HTMLInputElement>('Agent host or IP').disabled).toBe(false)
        expect(screen.getByLabelText<HTMLInputElement>('Agent port').disabled).toBe(false)
        expect(screen.queryAllByTestId('cancel-provisioning').length).toBe(0)
        view.rerender(<AddHostWizard {...makeProps({ isProvisioning: true })} />)
        expect(screen.getByLabelText<HTMLInputElement>('Agent host or IP').disabled).toBe(true)
        expect(screen.getByLabelText<HTMLInputElement>('Agent port').disabled).toBe(true)
        expect(screen.getByTestId('cancel-provisioning').textContent).toBe('Cancel')
      })

      it('shows the re-run hint only when retrying can help', async () => {
        const user = setupUser()
        const view = render(<AddHostWizard {...makeProps({ provisionError: { message: 'Connection refused', retryUseless: false } })} />)
        await enterHostName(user)
        await advanceToVerify(user)
        expect(screen.getByText('Use Re-run provisioning below to try again.')).toBeDefined()
        view.rerender(<AddHostWizard {...makeProps({ provisionError: { message: 'Connection refused', retryUseless: true } })} />)
        expect(screen.getByText('Connection refused')).toBeDefined()
        expect(screen.queryAllByText('Use Re-run provisioning below to try again.').length).toBe(0)
      })
    })

    it('keeps values from a previous ZFS choice out of the generated .env', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await openZfsStep(user)
      await user.type(screen.getByLabelText('HLM_ZFS_UID'), '1001')
      await user.type(screen.getByLabelText('HLM_ZFS_GID'), '1002')
      await user.type(screen.getByLabelText('DOCKER_GID'), '999')
      await user.click(nextButton())
      await user.click(screen.getByRole('button', { name: 'Back' }))
      await user.click(screen.getByRole('button', { name: 'Back' }))
      await user.click(screen.getByLabelText('ZFS capability'))
      await user.click(nextButton())
      await user.click(nextButton())
      const env = screen.getByTestId('step-env').textContent
      expect(env).toContain('AGENT_TRUSTED_PUBKEY=')
      expect(env).not.toContain('HLM_ZFS_UID')
      expect(env).not.toContain('HLM_ZFS_GID')
      expect(env).not.toContain('DOCKER_GID')
    })
  })

  describe('compose/env error fallbacks', () => {
    it('shows docker-compose.yml in the Compose File step', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      const composeStep = screen.getByTestId('step-compose')
      expect(composeStep).toBeDefined()
      const preElements = composeStep.querySelectorAll('pre')
      expect(preElements.length).toBe(1)
    })

    it('shows .env in the Configuration step', async () => {
      const user = setupUser()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      const envStep = screen.getByTestId('step-env')
      expect(envStep).toBeDefined()
      const preElements = envStep.querySelectorAll('pre')
      expect(preElements.length).toBe(1)
    })
  })
})
