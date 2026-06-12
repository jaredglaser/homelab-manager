import { describe, it, expect, mock } from 'bun:test'
import { render, screen, fireEvent } from '@testing-library/react'
import { ManagedHostsCardView } from '../ManagedHostsCard'
import type { ManagedHostsCardProps } from '../ManagedHostsCard'
import type { HostListItem } from '@/lib/hosts/host-utils'

const makeHost = (overrides?: Partial<HostListItem>): HostListItem => ({
  id: 1,
  name: 'server1',
  agentUrl: 'http://192.168.1.10:9090',
  capabilities: { docker: true, zfs: false },
  agentVersion: '1.2.3',
  status: 'healthy',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
})

function makeProps(overrides?: Partial<ManagedHostsCardProps>): ManagedHostsCardProps {
  return {
    hosts: [],
    isLoading: false,
    onAdd: mock(() => {}),
    isAdding: false,
    addError: null,
    verifyResult: null,
    onRemove: mock(() => {}),
    isRemoving: false,
    onUpdate: mock(() => {}),
    isUpdating: false,
    onHealthCheck: mock(() => {}),
    checkingHostIds: new Set<number>(),
    ...overrides,
  }
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

    it('renders both capability chips', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost({ capabilities: { docker: true, zfs: true } })] })} />)
      const chips = document.querySelectorAll('[data-slot="badge"]')
      const chipTexts = Array.from(chips).map((c) => c.textContent)
      expect(chipTexts).toContain('Docker')
      expect(chipTexts).toContain('ZFS')
    })
  })

  describe('health check', () => {
    it('calls onHealthCheck with host id when button clicked', () => {
      const onHealthCheck = mock(() => {})
      render(
        <ManagedHostsCardView
          {...makeProps({ hosts: [makeHost()], onHealthCheck })}
        />
      )
      fireEvent.click(screen.getByLabelText('check health'))
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
    it('opens confirm dialog when remove button is clicked', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()] })} />)
      fireEvent.click(screen.getByLabelText('remove host'))
      expect(screen.getByRole('dialog')).toBeDefined()
      expect(screen.getByRole('button', { name: 'Remove' })).toBeDefined()
    })

    it('shows host name in confirm dialog', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()] })} />)
      fireEvent.click(screen.getByLabelText('remove host'))
      const dialog = screen.getByRole('dialog')
      expect(dialog.textContent).toContain('server1')
    })

    it('calls onRemove with host id after confirm', () => {
      const onRemove = mock(() => {})
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()], onRemove })} />)
      fireEvent.click(screen.getByLabelText('remove host'))
      // Click the confirm Remove button (color="error" button inside the dialog)
      const removeBtn = screen.getByRole('button', { name: 'Remove' })
      fireEvent.click(removeBtn)
      expect(onRemove).toHaveBeenCalledWith(1)
    })

    it('does not call onRemove when Cancel is clicked', () => {
      const onRemove = mock(() => {})
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()], onRemove })} />)
      fireEvent.click(screen.getByLabelText('remove host'))
      fireEvent.click(screen.getByText('Cancel'))
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

    it('Next button advances to compose step (no ZFS)', () => {
      render(<ManagedHostsCardView {...makeProps()} />)
      // Docker is checked by default, ZFS is not, skip ZFS Setup
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-compose')).toBeDefined()
    })

    it('Next button advances to ZFS setup when ZFS is selected', () => {
      render(<ManagedHostsCardView {...makeProps()} />)
      fireEvent.click(screen.getByLabelText('ZFS capability'))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-zfs-setup')).toBeDefined()
    })

    it('ZFS setup step shows UID/GID fields', () => {
      render(<ManagedHostsCardView {...makeProps()} />)
      fireEvent.click(screen.getByLabelText('ZFS capability'))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByLabelText('HLM_ZFS_UID')).toBeDefined()
      expect(screen.getByLabelText('HLM_ZFS_GID')).toBeDefined()
    })

    it('ZFS setup shows DOCKER_GID when Docker is also selected', () => {
      render(<ManagedHostsCardView {...makeProps()} />)
      fireEvent.click(screen.getByLabelText('ZFS capability'))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByLabelText('DOCKER_GID')).toBeDefined()
    })

    it('Next is disabled on capabilities step when no capability selected', () => {
      render(<ManagedHostsCardView {...makeProps()} />)
      // Uncheck Docker (default checked)
      fireEvent.click(screen.getByLabelText('Docker capability'))
      const nextBtn = screen.getByRole('button', { name: 'Next' })
      expect(nextBtn.hasAttribute('disabled')).toBe(true)
    })

    it('compose step shows compose file content', () => {
      render(<ManagedHostsCardView {...makeProps()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByText('docker-compose.yml')).toBeDefined()
    })

    it('verify step shows Host Name and Agent URL fields', () => {
      render(<ManagedHostsCardView {...makeProps()} />)
      // Advance through capabilities -> compose -> configuration -> verify
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByLabelText('Host Name')).toBeDefined()
      expect(screen.getByLabelText('Agent URL')).toBeDefined()
    })

    it('Verify Connection button is disabled when fields are empty', () => {
      render(<ManagedHostsCardView {...makeProps()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      const btn = screen.getByRole('button', { name: /Verify Connection/ })
      expect(btn.hasAttribute('disabled')).toBe(true)
    })

    it('Verify Connection button is enabled when fields are filled', () => {
      render(<ManagedHostsCardView {...makeProps()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.change(screen.getByLabelText('Host Name'), { target: { value: 'server1' } })
      fireEvent.change(screen.getByLabelText('Agent URL'), { target: { value: 'http://localhost:9090' } })
      const btn = screen.getByRole('button', { name: /Verify Connection/ })
      expect(btn.hasAttribute('disabled')).toBe(false)
    })

    it('calls onAdd with name, url, and capabilities when Verify Connection is clicked', () => {
      const onAdd = mock(() => {})
      render(<ManagedHostsCardView {...makeProps({ onAdd })} />)
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.change(screen.getByLabelText('Host Name'), { target: { value: '  server1  ' } })
      fireEvent.change(screen.getByLabelText('Agent URL'), { target: { value: '  http://localhost:9090  ' } })
      fireEvent.click(screen.getByRole('button', { name: /Verify Connection/ }))
      expect(onAdd).toHaveBeenCalledTimes(1)
      const args = (onAdd as ReturnType<typeof mock>).mock.calls[0]
      expect(args[0]).toBe('server1')
      expect(args[1]).toBe('http://localhost:9090')
      expect(args[2]).toEqual({ docker: true, zfs: false })
    })

    it('Verify Connection button is disabled while isAdding', () => {
      render(<ManagedHostsCardView {...makeProps({ isAdding: true })} />)
      // Navigate to verify step: capabilities -> compose -> configuration -> verify
      // The Next button is not disabled by isAdding, only Back and Verify are
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      const btn = screen.getByRole('button', { name: /Verify Connection/ })
      expect(btn.hasAttribute('disabled')).toBe(true)
    })

    it('shows add error when addError is set', () => {
      render(
        <ManagedHostsCardView {...makeProps({ addError: 'Agent health check failed' })} />
      )
      expect(screen.getByText('Agent health check failed')).toBeDefined()
    })

    it('does not show error when addError is null', () => {
      render(<ManagedHostsCardView {...makeProps({ addError: null })} />)
      expect(screen.queryByText('Agent health check failed')).toBeNull()
    })

    it('Back button goes to previous step', () => {
      render(<ManagedHostsCardView {...makeProps()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('step-compose')).toBeDefined()
      fireEvent.click(screen.getByRole('button', { name: 'Back' }))
      expect(screen.getByTestId('step-capabilities')).toBeDefined()
    })

    it('Reset button returns to first step', () => {
      render(<ManagedHostsCardView {...makeProps()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
      expect(screen.getByTestId('step-capabilities')).toBeDefined()
    })

    it('shows public JWK after enrollment when verifyResult is set', () => {
      const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: 'mock-x' }
      render(<ManagedHostsCardView {...makeProps({ verifyResult: { publicJwk } })} />)
      // Navigate to verify step to see the JWK display
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByTestId('pubkey-display')).toBeDefined()
      expect(screen.getByText(/AGENT_TRUSTED_PUBKEY/)).toBeDefined()
      expect(screen.getByTestId('pubkey-display').textContent).toContain('"kty":"OKP"')
    })

    it('does not show JWK display when verifyResult is null', () => {
      render(<ManagedHostsCardView {...makeProps({ verifyResult: null })} />)
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.queryByTestId('pubkey-display')).toBeNull()
    })
  })

  describe('edit host', () => {
    it('renders edit host button per row', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()] })} />)
      expect(screen.getByLabelText('edit host')).toBeDefined()
    })

    it('opens edit dialog when edit button is clicked', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()] })} />)
      fireEvent.click(screen.getByLabelText('edit host'))
      expect(screen.getByRole('dialog')).toBeDefined()
      expect(screen.getByLabelText('Edit Host Name')).toBeDefined()
    })

    it('pre-fills edit dialog with current host values', () => {
      const host = makeHost({ name: 'myserver', agentUrl: 'http://10.0.0.1:9090' })
      render(<ManagedHostsCardView {...makeProps({ hosts: [host] })} />)
      fireEvent.click(screen.getByLabelText('edit host'))
      expect((screen.getByLabelText('Edit Host Name') as HTMLInputElement).value).toBe('myserver')
      expect((screen.getByLabelText('Edit Agent URL') as HTMLInputElement).value).toBe('http://10.0.0.1:9090')
    })

    it('edit dialog does not have Socket Proxy URL field', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()] })} />)
      fireEvent.click(screen.getByLabelText('edit host'))
      expect(screen.queryByLabelText('Edit Socket Proxy URL')).toBeNull()
    })

    it('calls onUpdate with correct values when Save is clicked', () => {
      const onUpdate = mock(() => {})
      const host = makeHost()
      render(<ManagedHostsCardView {...makeProps({ hosts: [host], onUpdate })} />)
      fireEvent.click(screen.getByLabelText('edit host'))
      fireEvent.change(screen.getByLabelText('Edit Host Name'), { target: { value: 'updated-server' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(onUpdate).toHaveBeenCalledWith(1, 'updated-server', 'http://192.168.1.10:9090')
    })

    it('does not call onUpdate when Cancel is clicked', () => {
      const onUpdate = mock(() => {})
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()], onUpdate })} />)
      fireEvent.click(screen.getByLabelText('edit host'))
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(onUpdate).not.toHaveBeenCalled()
    })

    it('Save button is disabled while isUpdating', () => {
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()], isUpdating: true })} />)
      fireEvent.click(screen.getByLabelText('edit host'))
      // When isUpdating, the button shows CircularProgress instead of 'Save' text
      const dialog = screen.getByRole('dialog')
      const buttons = Array.from(dialog.querySelectorAll('button'))
      const saveBtn = buttons.find((b) => b !== screen.getByRole('button', { name: 'Cancel' }))
      expect(saveBtn).toBeDefined()
      expect(saveBtn!.hasAttribute('disabled')).toBe(true)
    })
  })

})
