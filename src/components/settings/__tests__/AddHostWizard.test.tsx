import { describe, it, expect, mock } from 'bun:test'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@/lib/test/testing-library'
import AddHostWizard, { type PendingHostState } from '@/components/settings/AddHostWizard'

interface WizardProps {
  isCreating: boolean
  isProvisioning: boolean
  createError: string | null
  provisionError: string | null
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
    onCreateHost: mock(() => {}),
    onVerify: mock(() => {}),
    onCancelVerify: mock(() => {}),
    onDiscard: mock(() => {}),
    ...overrides,
  }
}

async function enterHostName(user: ReturnType<typeof userEvent.setup>, value = 'dev-machine') {
  await user.type(screen.getByLabelText('Host Name'), value)
}

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
      const user = userEvent.setup()
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
      const user = userEvent.setup()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-compose')).toBeDefined()
    })

    it('creates the pending host when entering the Compose File step', async () => {
      const user = userEvent.setup()
      const onCreateHost = mock(() => {})
      render(<AddHostWizard {...makeProps({ onCreateHost })} />)
      await enterHostName(user, '  dev-machine  ')
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(onCreateHost).toHaveBeenCalledWith('dev-machine', { docker: true, zfs: false })
    })

    it('creates the pending host with ZFS capabilities when leaving the ZFS Setup step', async () => {
      const user = userEvent.setup()
      const onCreateHost = mock(() => {})
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
      const user = userEvent.setup()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByRole('button', { name: 'Back' })).toBeDefined()
    })

    it('goes back to Capabilities when Back is clicked from Compose step', async () => {
      const user = userEvent.setup()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Back' }))
      expect(screen.getByTestId('step-capabilities')).toBeDefined()
    })

    it('advances to Configuration from Compose File', async () => {
      const user = userEvent.setup()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      // Capabilities → Compose
      await user.click(screen.getByRole('button', { name: 'Next' }))
      // Compose → Configuration
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-env')).toBeDefined()
    })

    it('advances to Verify Connection from Configuration', async () => {
      const user = userEvent.setup()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      // Capabilities → Compose → Configuration → Verify
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-verify')).toBeDefined()
    })

    it('does not show Next button on Verify Connection step', async () => {
      const user = userEvent.setup()
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
      const user = userEvent.setup()
      render(<AddHostWizard {...makeProps()} />)
      await user.click(screen.getByLabelText('ZFS capability'))
      expect(screen.getByText('ZFS Setup')).toBeDefined()
    })

    it('shows ZFS Setup content when navigating to that step with ZFS enabled', async () => {
      const user = userEvent.setup()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByLabelText('ZFS capability'))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-zfs-setup')).toBeDefined()
    })

    it('Next is disabled on ZFS Setup step until UID and GID are filled', async () => {
      const user = userEvent.setup()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByLabelText('ZFS capability'))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      const nextBtn = screen.getByRole('button', { name: 'Next' })
      expect(nextBtn.hasAttribute('disabled')).toBe(true)
    })

    it('Next is enabled on ZFS Setup once UID, GID, and Docker GID are filled', async () => {
      const user = userEvent.setup()
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
      const user = userEvent.setup()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      // Uncheck Docker, check ZFS
      await user.click(screen.getByLabelText('Docker capability'))
      await user.click(screen.getByLabelText('ZFS capability'))
      // Go to ZFS Setup step
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.queryByLabelText('DOCKER_GID')).toBeNull()
    })
  })

  describe('Verify Connection step', () => {
    async function navigateToVerify(user: ReturnType<typeof userEvent.setup>, name = 'dev-machine') {
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user, name)
      // Capabilities → Compose → Configuration → Verify
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
    }

    it('shows the agent host and port fields with the port defaulting to 9090', async () => {
      const user = userEvent.setup()
      await navigateToVerify(user)
      expect(screen.getByLabelText('Agent host or IP')).toBeDefined()
      const port = screen.getByLabelText('Agent port') as HTMLInputElement
      expect(port.value).toBe('9090')
    })

    it('Verify Connection button is disabled when the host is empty', async () => {
      const user = userEvent.setup()
      await navigateToVerify(user)
      const btn = screen.getByRole('button', { name: 'Verify Connection' })
      expect(btn.hasAttribute('disabled')).toBe(true)
    })

    it('Verify Connection button is enabled once the host is filled', async () => {
      const user = userEvent.setup()
      await navigateToVerify(user)
      await user.type(screen.getByLabelText('Agent host or IP'), '192.168.1.10')
      const btn = screen.getByRole('button', { name: 'Verify Connection' })
      expect(btn.hasAttribute('disabled')).toBe(false)
    })

    it('Verify Connection button is disabled when the port is not a valid port', async () => {
      const user = userEvent.setup()
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
      const user = userEvent.setup()
      const view = render(<AddHostWizard {...makeProps({ pendingHost: null })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      // isCreating turns on only after the Next click lands (the create call), like the real flow.
      view.rerender(<AddHostWizard {...makeProps({ pendingHost: null, isCreating: true })} />)
      expect(screen.getByTestId('step-compose-loading')).toBeDefined()
      expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true)
    })

    it('composes a plain-HTTP URL from the host and port when Verify Connection is clicked', async () => {
      const user = userEvent.setup()
      const onVerify = mock(() => {})
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

    it('accepts a bracketed IPv6 literal and keeps the brackets in the composed URL', async () => {
      const user = userEvent.setup()
      const onVerify = mock(() => {})
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
      const user = userEvent.setup()
      const onVerify = mock(() => {})
      render(<AddHostWizard {...makeProps({ onVerify })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.type(screen.getByLabelText('Agent host or IP'), '2001:db8::1')
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(true)
      expect(onVerify).not.toHaveBeenCalled()
    })

    it('never produces an HTTPS URL, whatever the operator types', async () => {
      const user = userEvent.setup()
      const onVerify = mock(() => {})
      render(<AddHostWizard {...makeProps({ onVerify })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      // A scheme typed into the host field is rejected as an invalid hostname.
      await user.type(screen.getByLabelText('Agent host or IP'), 'https://192.168.1.10')
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(true)
      expect(onVerify).not.toHaveBeenCalled()
    })

    it('does not call onVerify when isProvisioning is true', async () => {
      const user = userEvent.setup()
      const onVerify = mock(() => {})
      render(<AddHostWizard {...makeProps({ onVerify, isProvisioning: true })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.type(screen.getByLabelText('Agent host or IP'), '192.168.1.10')
      const btn = screen.getByRole('button', { name: /Verifying/ })
      expect(btn.hasAttribute('disabled')).toBe(true)
      await user.click(btn)
      expect(onVerify).not.toHaveBeenCalled()
    })

    it('shows a Verifying loading state and a cancel action while provisioning', async () => {
      const user = userEvent.setup()
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
      const user = userEvent.setup()
      const onCancelVerify = mock(() => {})
      render(<AddHostWizard {...makeProps({ onCancelVerify, isProvisioning: true })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByTestId('cancel-provisioning'))
      expect(onCancelVerify).toHaveBeenCalledTimes(1)
    })

    it('does not show a pubkey display on the verify step: the key lives in the compose', async () => {
      const user = userEvent.setup()
      await navigateToVerify(user)
      expect(screen.queryByTestId('pubkey-display')).toBeNull()
    })

    it('shows the provisioning error with a re-run provisioning action on failure', async () => {
      const user = userEvent.setup()
      render(<AddHostWizard {...makeProps({ provisionError: 'TLS provisioning failed: the agent did not become healthy over HTTPS.' })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('rerun-provisioning')).toBeDefined()
      expect(screen.getByText(/TLS provisioning failed/)).toBeDefined()
    })

    it('does not show the re-run action when there is no provisioning error', async () => {
      const user = userEvent.setup()
      await navigateToVerify(user)
      expect(screen.queryByTestId('rerun-provisioning')).toBeNull()
    })
  })

  describe('compose generation', () => {
    it('bakes the host name into AGENT_HOST_NAME in the compose snippet', async () => {
      const user = userEvent.setup()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user, 'my-host')
      await user.click(screen.getByRole('button', { name: 'Next' }))
      const composeStep = screen.getByTestId('step-compose')
      expect(composeStep.textContent).toContain('AGENT_HOST_NAME: my-host')
    })

    it('references the key in the compose without embedding it, and puts the real key in the .env', async () => {
      const user = userEvent.setup()
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
      const user = userEvent.setup()
      const view = render(<AddHostWizard {...makeProps({ pendingHost: null })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      view.rerender(<AddHostWizard {...makeProps({ pendingHost: null, isCreating: true })} />)
      const loading = screen.getByTestId('step-compose-loading')
      expect(loading.textContent).toContain("Generating this host's keypair")
      expect(loading.querySelector('pre')).toBeNull()
    })

    it('shows an idle line on the Compose step when creation has not started', async () => {
      const user = userEvent.setup()
      render(<AddHostWizard {...makeProps({ pendingHost: null })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByText('The keypair is generated when you reach this step.')).toBeDefined()
      expect(screen.queryByTestId('step-compose-loading')).toBeNull()
    })

    it('shows the create error without a spinner on the Compose step when creation failed', async () => {
      const user = userEvent.setup()
      render(<AddHostWizard {...makeProps({ pendingHost: null, createError: 'Failed to generate agent keypair: disk full' })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByText(/Failed to generate agent keypair/)).toBeDefined()
      expect(screen.queryByTestId('step-compose-loading')).toBeNull()
    })
  })

  describe('error display', () => {
    it('shows the provisioning error with a re-run action on the verify step when provisionError is set', async () => {
      const user = userEvent.setup()
      render(<AddHostWizard {...makeProps({ provisionError: 'Connection refused' })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByText('Connection refused')).toBeDefined()
      expect(screen.getByTestId('rerun-provisioning')).toBeDefined()
    })

    it('does not show an error alert when createError and provisionError are null', async () => {
      const user = userEvent.setup()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.queryByRole('alert')).toBeNull()
    })
  })

  describe('Reset', () => {
    it('resets back to Capabilities step', async () => {
      const user = userEvent.setup()
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
      const user = userEvent.setup()
      const onDiscard = mock(() => {})
      render(<AddHostWizard {...makeProps({ onDiscard })} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Reset' }))
      expect(onDiscard).toHaveBeenCalledTimes(1)
    })

    it('clears the host name on reset', async () => {
      const user = userEvent.setup()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user, 'dev-machine')
      await user.click(screen.getByRole('button', { name: 'Reset' }))
      expect((screen.getByLabelText('Host Name') as HTMLInputElement).value).toBe('')
    })

    it('resets ZFS checkbox to unchecked', async () => {
      const user = userEvent.setup()
      render(<AddHostWizard {...makeProps()} />)
      await user.click(screen.getByLabelText('ZFS capability'))
      expect(screen.getByLabelText('ZFS capability').getAttribute('aria-checked')).toBe('true')
      await user.click(screen.getByRole('button', { name: 'Reset' }))
      expect(screen.getByLabelText('ZFS capability').getAttribute('aria-checked')).toBe('false')
    })

    it('Reset button is disabled while creating or provisioning', () => {
      render(<AddHostWizard {...makeProps({ isCreating: true })} />)
      const resetBtn = screen.getByRole('button', { name: 'Reset' })
      expect(resetBtn.hasAttribute('disabled')).toBe(true)
    })
  })

  describe('compose/env error fallbacks', () => {
    it('shows docker-compose.yml in the Compose File step', async () => {
      const user = userEvent.setup()
      render(<AddHostWizard {...makeProps()} />)
      await enterHostName(user)
      await user.click(screen.getByRole('button', { name: 'Next' }))
      const composeStep = screen.getByTestId('step-compose')
      expect(composeStep).toBeDefined()
      const preElements = composeStep.querySelectorAll('pre')
      expect(preElements.length).toBe(1)
    })

    it('shows .env in the Configuration step', async () => {
      const user = userEvent.setup()
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
