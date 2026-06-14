import { describe, it, expect, mock } from 'bun:test'
import { render, screen, fireEvent } from '@testing-library/react'
import '@/lib/test/testing-library'
import AddHostWizard from '@/components/settings/AddHostWizard'

interface WizardProps {
  isAdding: boolean
  addError: string | null
  onSubmit: (name: string, agentUrl: string, capabilities: { docker: boolean; zfs: boolean }) => void
  verifyResult: { publicJwk: unknown } | null
}

function makeProps(overrides?: Partial<WizardProps>): WizardProps {
  return {
    isAdding: false,
    addError: null,
    onSubmit: mock(() => {}),
    verifyResult: null,
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

    it('shows the Agent URL field', () => {
      navigateToVerify()
      expect(screen.getByLabelText('Agent URL')).toBeDefined()
    })

    it('Verify Connection button is disabled when the agent URL is empty', () => {
      navigateToVerify()
      const btn = screen.getByRole('button', { name: 'Verify Connection' })
      expect(btn.hasAttribute('disabled')).toBe(true)
    })

    it('Verify Connection button is enabled once the agent URL is filled', () => {
      navigateToVerify()
      fireEvent.change(screen.getByLabelText('Agent URL'), { target: { value: 'http://192.168.1.10:9090' } })
      const btn = screen.getByRole('button', { name: 'Verify Connection' })
      expect(btn.hasAttribute('disabled')).toBe(false)
    })

    it('calls onSubmit with trimmed name, url, and capabilities when Verify Connection is clicked', () => {
      const onSubmit = mock(() => {})
      render(<AddHostWizard isAdding={false} addError={null} onSubmit={onSubmit} verifyResult={null} />)
      enterHostName('  dev-machine  ')
      // Capabilities → Compose → Configuration → Verify
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.change(screen.getByLabelText('Agent URL'), { target: { value: '  http://192.168.1.10:9090  ' } })
      fireEvent.click(screen.getByRole('button', { name: 'Verify Connection' }))
      expect(onSubmit).toHaveBeenCalledTimes(1)
      const callArgs = onSubmit.mock.calls[0] as unknown as [string, string, { docker: boolean; zfs: boolean }]
      const [name, agentUrl, capabilities] = callArgs
      expect(name).toBe('dev-machine')
      expect(agentUrl).toBe('http://192.168.1.10:9090')
      expect(capabilities).toEqual({ docker: true, zfs: false })
    })

    it('does not call onSubmit when isAdding is true', () => {
      const onSubmit = mock(() => {})
      render(<AddHostWizard isAdding={true} addError={null} onSubmit={onSubmit} verifyResult={null} />)
      enterHostName()
      // Capabilities → Compose → Configuration → Verify
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      // Populate the agent URL so the button is disabled only because isAdding=true
      fireEvent.change(screen.getByLabelText('Agent URL'), { target: { value: 'https://192.168.1.10:9090' } })
      const btn = screen.getByRole('button', { name: 'Verify Connection' })
      // Button is disabled while adding even when fields are populated
      expect(btn.hasAttribute('disabled')).toBe(true)
      fireEvent.click(btn)
      expect(onSubmit).not.toHaveBeenCalled()
    })

    it('shows public JWK after successful verification', () => {
      const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: 'mock-x' }
      render(<AddHostWizard {...makeProps({ verifyResult: { publicJwk } })} />)
      enterHostName()
      // Navigate to Verify step
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('pubkey-display')).toBeDefined()
      expect(screen.getByText(/AGENT_TRUSTED_PUBKEY/)).toBeDefined()
      expect(screen.getByTestId('pubkey-display').textContent).toContain('"kty":"OKP"')
    })

    it('does not show public JWK when verifyResult is null', () => {
      render(<AddHostWizard {...makeProps({ verifyResult: null })} />)
      enterHostName()
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.queryByTestId('pubkey-display')).toBeNull()
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
  })

  describe('error display', () => {
    it('shows error alert when addError is set', () => {
      render(<AddHostWizard {...makeProps({ addError: 'Connection refused' })} />)
      expect(screen.getByText('Connection refused')).toBeDefined()
    })

    it('does not show alert when addError is null', () => {
      render(<AddHostWizard {...makeProps({ addError: null })} />)
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

    it('Reset button is disabled while isAdding', () => {
      render(<AddHostWizard {...makeProps({ isAdding: true })} />)
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
