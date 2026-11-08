import { describe, it, expect, mock } from 'bun:test'
import { render, screen, fireEvent } from '@testing-library/react'
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

function enterHostName(value = 'dev-machine') {
  fireEvent.change(screen.getByLabelText('Host Name'), { target: { value } })
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

    it('Next is disabled until a host name is entered', () => {
      render(<AddHostWizard {...makeProps()} />)
      expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true)
      enterHostName()
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
    it('advances from Capabilities to Compose File when Next is clicked', () => {
      render(<AddHostWizard {...makeProps()} />)
      enterHostName()
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-compose')).toBeDefined()
    })

    it('creates the pending host when entering the Compose File step', () => {
      const onCreateHost = mock(() => {})
      render(<AddHostWizard {...makeProps({ onCreateHost })} />)
      enterHostName('  dev-machine  ')
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(onCreateHost).toHaveBeenCalledWith('dev-machine', { docker: true, zfs: false })
    })

    it('creates the pending host with ZFS capabilities when leaving the ZFS Setup step', () => {
      const onCreateHost = mock(() => {})
      render(<AddHostWizard {...makeProps({ onCreateHost })} />)
      enterHostName()
      fireEvent.click(screen.getByLabelText('ZFS capability'))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.change(screen.getByLabelText('HLM_ZFS_UID'), { target: { value: '1001' } })
      fireEvent.change(screen.getByLabelText('HLM_ZFS_GID'), { target: { value: '1001' } })
      fireEvent.change(screen.getByLabelText('DOCKER_GID'), { target: { value: '999' } })
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(onCreateHost).toHaveBeenCalledWith('dev-machine', { docker: true, zfs: true })
    })

    it('shows Back button after advancing past first step', () => {
      render(<AddHostWizard {...makeProps()} />)
      enterHostName()
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByRole('button', { name: 'Back' })).toBeDefined()
    })

    it('goes back to Capabilities when Back is clicked from Compose step', () => {
      render(<AddHostWizard {...makeProps()} />)
      enterHostName()
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Back' }))
      expect(screen.getByTestId('step-capabilities')).toBeDefined()
    })

    it('advances to Configuration from Compose File', () => {
      render(<AddHostWizard {...makeProps()} />)
      enterHostName()
      // Capabilities → Compose
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      // Compose → Configuration
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-env')).toBeDefined()
    })

    it('advances to Verify Connection from Configuration', () => {
      render(<AddHostWizard {...makeProps()} />)
      enterHostName()
      // Capabilities → Compose → Configuration → Verify
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-verify')).toBeDefined()
    })

    it('does not show Next button on Verify Connection step', () => {
      render(<AddHostWizard {...makeProps()} />)
      enterHostName()
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
    })
  })

  describe('ZFS step', () => {
    it('shows ZFS Setup step in stepper when ZFS is checked', () => {
      render(<AddHostWizard {...makeProps()} />)
      fireEvent.click(screen.getByLabelText('ZFS capability'))
      expect(screen.getByText('ZFS Setup')).toBeDefined()
    })

    it('shows ZFS Setup content when navigating to that step with ZFS enabled', () => {
      render(<AddHostWizard {...makeProps()} />)
      enterHostName()
      fireEvent.click(screen.getByLabelText('ZFS capability'))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-zfs-setup')).toBeDefined()
    })

    it('Next is disabled on ZFS Setup step until UID and GID are filled', () => {
      render(<AddHostWizard {...makeProps()} />)
      enterHostName()
      fireEvent.click(screen.getByLabelText('ZFS capability'))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      const nextBtn = screen.getByRole('button', { name: 'Next' })
      expect(nextBtn.hasAttribute('disabled')).toBe(true)
    })

    it('Next is enabled on ZFS Setup once UID, GID, and Docker GID are filled', () => {
      render(<AddHostWizard {...makeProps()} />)
      enterHostName()
      // Enable ZFS (Docker already checked)
      fireEvent.click(screen.getByLabelText('ZFS capability'))
      // Go to ZFS Setup step
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.change(screen.getByLabelText('HLM_ZFS_UID'), { target: { value: '1001' } })
      fireEvent.change(screen.getByLabelText('HLM_ZFS_GID'), { target: { value: '1001' } })
      fireEvent.change(screen.getByLabelText('DOCKER_GID'), { target: { value: '999' } })
      const nextBtn = screen.getByRole('button', { name: 'Next' })
      expect(nextBtn.hasAttribute('disabled')).toBe(false)
    })

    it('does not show DOCKER_GID field when Docker is unchecked', () => {
      render(<AddHostWizard {...makeProps()} />)
      enterHostName()
      // Uncheck Docker, check ZFS
      fireEvent.click(screen.getByLabelText('Docker capability'))
      fireEvent.click(screen.getByLabelText('ZFS capability'))
      // Go to ZFS Setup step
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.queryByLabelText('DOCKER_GID')).toBeNull()
    })
  })

  describe('Verify Connection step', () => {
    function navigateToVerify(name = 'dev-machine') {
      render(<AddHostWizard {...makeProps()} />)
      enterHostName(name)
      // Capabilities → Compose → Configuration → Verify
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    }

    it('shows the agent host and port fields with the port defaulting to 9090', () => {
      navigateToVerify()
      expect(screen.getByLabelText('Agent host or IP')).toBeDefined()
      const port = screen.getByLabelText('Agent port') as HTMLInputElement
      expect(port.value).toBe('9090')
    })

    it('Verify Connection button is disabled when the host is empty', () => {
      navigateToVerify()
      const btn = screen.getByRole('button', { name: 'Verify Connection' })
      expect(btn.hasAttribute('disabled')).toBe(true)
    })

    it('Verify Connection button is enabled once the host is filled', () => {
      navigateToVerify()
      fireEvent.change(screen.getByLabelText('Agent host or IP'), { target: { value: '192.168.1.10' } })
      const btn = screen.getByRole('button', { name: 'Verify Connection' })
      expect(btn.hasAttribute('disabled')).toBe(false)
    })

    it('Verify Connection button is disabled when the port is not a valid port', () => {
      navigateToVerify()
      fireEvent.change(screen.getByLabelText('Agent host or IP'), { target: { value: '192.168.1.10' } })
      fireEvent.change(screen.getByLabelText('Agent port'), { target: { value: '99999' } })
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(true)
      fireEvent.change(screen.getByLabelText('Agent port'), { target: { value: 'abc' } })
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(true)
    })

    it('Next is disabled on the Compose step while the keypair has not been created', () => {
      render(<AddHostWizard {...makeProps({ pendingHost: null })} />)
      enterHostName()
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-compose-loading')).toBeDefined()
      expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true)
    })

    it('composes a plain-HTTP URL from the host and port when Verify Connection is clicked', () => {
      const onVerify = mock(() => {})
      render(<AddHostWizard {...makeProps({ onVerify })} />)
      enterHostName('  dev-machine  ')
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.change(screen.getByLabelText('Agent host or IP'), { target: { value: '  192.168.1.10  ' } })
      fireEvent.change(screen.getByLabelText('Agent port'), { target: { value: '9191' } })
      fireEvent.click(screen.getByRole('button', { name: 'Verify Connection' }))
      expect(onVerify).toHaveBeenCalledTimes(1)
      expect(onVerify).toHaveBeenCalledWith(1, 'http://192.168.1.10:9191')
    })

    it('never produces an HTTPS URL, whatever the operator types', () => {
      const onVerify = mock(() => {})
      render(<AddHostWizard {...makeProps({ onVerify })} />)
      enterHostName()
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      // A scheme typed into the host field is rejected as an invalid hostname.
      fireEvent.change(screen.getByLabelText('Agent host or IP'), { target: { value: 'https://192.168.1.10' } })
      expect(screen.getByRole('button', { name: 'Verify Connection' }).hasAttribute('disabled')).toBe(true)
      expect(onVerify).not.toHaveBeenCalled()
    })

    it('does not call onVerify when isProvisioning is true', () => {
      const onVerify = mock(() => {})
      render(<AddHostWizard {...makeProps({ onVerify, isProvisioning: true })} />)
      enterHostName()
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.change(screen.getByLabelText('Agent host or IP'), { target: { value: '192.168.1.10' } })
      const btn = screen.getByRole('button', { name: /Verifying/ })
      expect(btn.hasAttribute('disabled')).toBe(true)
      fireEvent.click(btn)
      expect(onVerify).not.toHaveBeenCalled()
    })

    it('shows a Verifying loading state and a cancel action while provisioning', () => {
      render(<AddHostWizard {...makeProps({ isProvisioning: true })} />)
      enterHostName()
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByRole('button', { name: /Verifying/ })).toBeDefined()
      expect(screen.queryByRole('button', { name: 'Verify Connection' })).toBeNull()
      expect(screen.getByTestId('cancel-provisioning')).toBeDefined()
    })

    it('cancel button calls onCancelVerify', () => {
      const onCancelVerify = mock(() => {})
      render(<AddHostWizard {...makeProps({ onCancelVerify, isProvisioning: true })} />)
      enterHostName()
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByTestId('cancel-provisioning'))
      expect(onCancelVerify).toHaveBeenCalledTimes(1)
    })

    it('does not show a pubkey display on the verify step: the key lives in the compose', () => {
      navigateToVerify()
      expect(screen.queryByTestId('pubkey-display')).toBeNull()
    })

    it('shows the provisioning error with a re-run provisioning action on failure', () => {
      render(<AddHostWizard {...makeProps({ provisionError: 'TLS provisioning failed: the agent did not become healthy over HTTPS.' })} />)
      enterHostName()
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('rerun-provisioning')).toBeDefined()
      expect(screen.getByText(/TLS provisioning failed/)).toBeDefined()
    })

    it('does not show the re-run action when there is no provisioning error', () => {
      navigateToVerify()
      expect(screen.queryByTestId('rerun-provisioning')).toBeNull()
    })
  })

  describe('compose generation', () => {
    it('bakes the host name into AGENT_HOST_NAME in the compose snippet', () => {
      render(<AddHostWizard {...makeProps()} />)
      enterHostName('my-host')
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      const composeStep = screen.getByTestId('step-compose')
      expect(composeStep.textContent).toContain('AGENT_HOST_NAME: my-host')
    })

    it('references the key in the compose without embedding it, and puts the real key in the .env', () => {
      render(<AddHostWizard {...makeProps()} />)
      enterHostName()
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      const composeStep = screen.getByTestId('step-compose')
      expect(composeStep.textContent).toContain('AGENT_TRUSTED_PUBKEY: ${AGENT_TRUSTED_PUBKEY}')
      expect(composeStep.textContent).not.toContain('wizard-key-x')
      expect(composeStep.textContent).not.toContain('"kty"')
      // Advance to Configuration: the .env carries the real key.
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      const envStep = screen.getByTestId('step-env')
      expect(envStep.textContent).toContain('AGENT_TRUSTED_PUBKEY={"kty":"OKP","crv":"Ed25519","x":"wizard-key-x"}')
    })

    it('shows a keypair spinner on the Compose step before the pending host exists', () => {
      render(<AddHostWizard {...makeProps({ pendingHost: null })} />)
      enterHostName()
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      const loading = screen.getByTestId('step-compose-loading')
      expect(loading.textContent).toContain("Generating this host's keypair")
      expect(loading.querySelector('pre')).toBeNull()
    })

    it('shows the create error on the Compose step when creation failed', () => {
      render(<AddHostWizard {...makeProps({ pendingHost: null, createError: 'Failed to generate agent keypair: disk full' })} />)
      enterHostName()
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByText(/Failed to generate agent keypair/)).toBeDefined()
    })
  })

  describe('error display', () => {
    it('shows the provisioning error with a re-run action on the verify step when provisionError is set', () => {
      render(<AddHostWizard {...makeProps({ provisionError: 'Connection refused' })} />)
      enterHostName()
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByText('Connection refused')).toBeDefined()
      expect(screen.getByTestId('rerun-provisioning')).toBeDefined()
    })

    it('does not show an error alert when createError and provisionError are null', () => {
      render(<AddHostWizard {...makeProps()} />)
      enterHostName()
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.queryByRole('alert')).toBeNull()
    })
  })

  describe('Reset', () => {
    it('resets back to Capabilities step', () => {
      render(<AddHostWizard {...makeProps()} />)
      enterHostName()
      // Advance to Compose File
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-compose')).toBeDefined()
      // Reset
      fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
      expect(screen.getByTestId('step-capabilities')).toBeDefined()
    })

    it('discards the pending host on reset', () => {
      const onDiscard = mock(() => {})
      render(<AddHostWizard {...makeProps({ onDiscard })} />)
      enterHostName()
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
      expect(onDiscard).toHaveBeenCalledTimes(1)
    })

    it('clears the host name on reset', () => {
      render(<AddHostWizard {...makeProps()} />)
      enterHostName('dev-machine')
      fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
      expect((screen.getByLabelText('Host Name') as HTMLInputElement).value).toBe('')
    })

    it('resets ZFS checkbox to unchecked', () => {
      render(<AddHostWizard {...makeProps()} />)
      fireEvent.click(screen.getByLabelText('ZFS capability'))
      expect(screen.getByLabelText('ZFS capability').getAttribute('aria-checked')).toBe('true')
      fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
      expect(screen.getByLabelText('ZFS capability').getAttribute('aria-checked')).toBe('false')
    })

    it('Reset button is disabled while creating or provisioning', () => {
      render(<AddHostWizard {...makeProps({ isCreating: true })} />)
      const resetBtn = screen.getByRole('button', { name: 'Reset' })
      expect(resetBtn.hasAttribute('disabled')).toBe(true)
    })
  })

  describe('compose/env error fallbacks', () => {
    it('shows docker-compose.yml in the Compose File step', () => {
      render(<AddHostWizard {...makeProps()} />)
      enterHostName()
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      const composeStep = screen.getByTestId('step-compose')
      expect(composeStep).toBeDefined()
      const preElements = composeStep.querySelectorAll('pre')
      expect(preElements.length).toBe(1)
    })

    it('shows .env in the Configuration step', () => {
      render(<AddHostWizard {...makeProps()} />)
      enterHostName()
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      const envStep = screen.getByTestId('step-env')
      expect(envStep).toBeDefined()
      const preElements = envStep.querySelectorAll('pre')
      expect(preElements.length).toBe(1)
    })
  })
})
