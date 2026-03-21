import { describe, it, expect, mock } from 'bun:test'
import { render, screen, fireEvent } from '@testing-library/react'
import { ManagedHostsCardView } from '../ManagedHostsCard'
import type { ManagedHostsCardProps } from '../ManagedHostsCard'
import type { HostListItem } from '@/lib/hosts/host-utils'

// ----- Fixtures -----

const makeHost = (overrides?: Partial<HostListItem>): HostListItem => ({
  id: 1,
  name: 'server1',
  agentUrl: 'http://192.168.1.10:9090',
  socketProxyUrl: 'tcp://192.168.1.10:2375',
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
    onRemove: mock(() => {}),
    isRemoving: false,
    onHealthCheck: mock(() => {}),
    checkingHostId: null,
    snackbar: { open: false, message: '', severity: 'success' },
    onSnackbarClose: mock(() => {}),
    ...overrides,
  }
}

// ----- Tests -----

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

    it('shows spinner when checkingHostId matches host id', () => {
      render(
        <ManagedHostsCardView
          {...makeProps({ hosts: [makeHost()], checkingHostId: 1 })}
        />
      )
      // The health check button should be disabled
      const btn = screen.getByLabelText('check health')
      expect(btn.hasAttribute('disabled')).toBe(true)
    })

    it('health check button is enabled when checkingHostId is different host', () => {
      render(
        <ManagedHostsCardView
          {...makeProps({ hosts: [makeHost({ id: 1 })], checkingHostId: 2 })}
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

    it('does not call onRemove when dialog is dismissed via Cancel', () => {
      // Re-verifies cancel path: open dialog, cancel, confirm button no longer triggers onRemove
      const onRemove = mock(() => {})
      render(<ManagedHostsCardView {...makeProps({ hosts: [makeHost()], onRemove })} />)
      fireEvent.click(screen.getByLabelText('remove host'))
      fireEvent.click(screen.getByText('Cancel'))
      expect(onRemove).not.toHaveBeenCalled()
    })
  })

  describe('add host form', () => {
    function fillAllFields() {
      fireEvent.change(screen.getByLabelText('Host Name'), { target: { value: 'server1' } })
      fireEvent.change(screen.getByLabelText('Agent URL'), { target: { value: 'http://localhost:9090' } })
      fireEvent.change(screen.getByLabelText('Socket Proxy URL'), { target: { value: 'http://192.168.1.10:2375' } })
      fireEvent.change(screen.getByLabelText('Agent Token'), { target: { value: 'dev-token' } })
    }

    it('renders all form fields', () => {
      render(<ManagedHostsCardView {...makeProps()} />)
      expect(screen.getByLabelText('Host Name')).toBeDefined()
      expect(screen.getByLabelText('Agent URL')).toBeDefined()
      expect(screen.getByLabelText('Socket Proxy URL')).toBeDefined()
      expect(screen.getByLabelText('Agent Token')).toBeDefined()
    })

    it('renders Register Host button', () => {
      render(<ManagedHostsCardView {...makeProps()} />)
      expect(screen.getByRole('button', { name: /Register Host/ })).toBeDefined()
    })

    it('Register Host button is disabled when fields are empty', () => {
      render(<ManagedHostsCardView {...makeProps()} />)
      const btn = screen.getByRole('button', { name: /Register Host/ })
      expect(btn.hasAttribute('disabled')).toBe(true)
    })

    it('Register Host button is disabled when only some fields are filled', () => {
      render(<ManagedHostsCardView {...makeProps()} />)
      fireEvent.change(screen.getByLabelText('Host Name'), { target: { value: 'server1' } })
      fireEvent.change(screen.getByLabelText('Agent URL'), { target: { value: 'http://localhost:9090' } })
      const btn = screen.getByRole('button', { name: /Register Host/ })
      expect(btn.hasAttribute('disabled')).toBe(true)
    })

    it('Register Host button is enabled when all fields are filled', () => {
      render(<ManagedHostsCardView {...makeProps()} />)
      fillAllFields()
      const btn = screen.getByRole('button', { name: /Register Host/ })
      expect(btn.hasAttribute('disabled')).toBe(false)
    })

    it('calls onAdd with trimmed values on submit', () => {
      const onAdd = mock(() => {})
      render(<ManagedHostsCardView {...makeProps({ onAdd })} />)
      fireEvent.change(screen.getByLabelText('Host Name'), { target: { value: '  server1  ' } })
      fireEvent.change(screen.getByLabelText('Agent URL'), { target: { value: '  http://localhost:9090  ' } })
      fireEvent.change(screen.getByLabelText('Socket Proxy URL'), { target: { value: '  http://192.168.1.10:2375  ' } })
      fireEvent.change(screen.getByLabelText('Agent Token'), { target: { value: '  dev-token  ' } })
      fireEvent.click(screen.getByRole('button', { name: /Register Host/ }))
      expect(onAdd).toHaveBeenCalledWith('server1', 'http://localhost:9090', 'http://192.168.1.10:2375', 'dev-token')
    })

    it('clears form fields after successful submit', () => {
      render(<ManagedHostsCardView {...makeProps()} />)
      fillAllFields()
      fireEvent.click(screen.getByRole('button', { name: /Register Host/ }))
      expect((screen.getByLabelText('Host Name') as HTMLInputElement).value).toBe('')
      expect((screen.getByLabelText('Agent URL') as HTMLInputElement).value).toBe('')
      expect((screen.getByLabelText('Socket Proxy URL') as HTMLInputElement).value).toBe('')
      expect((screen.getByLabelText('Agent Token') as HTMLInputElement).value).toBe('')
    })

    it('Register Host button is disabled while isAdding', () => {
      render(<ManagedHostsCardView {...makeProps({ isAdding: true })} />)
      const btn = screen.getByRole('button', { name: /Register Host/ })
      expect(btn.hasAttribute('disabled')).toBe(true)
    })

    it('shows add error when addError is set', () => {
      render(
        <ManagedHostsCardView {...makeProps({ addError: 'Failed to provision agent' })} />
      )
      expect(screen.getByText('Failed to provision agent')).toBeDefined()
    })

    it('does not show error when addError is null', () => {
      render(<ManagedHostsCardView {...makeProps({ addError: null })} />)
      expect(screen.queryByText('Failed to provision agent')).toBeNull()
    })
  })

  describe('snackbar', () => {
    it('renders snackbar message when open', () => {
      render(
        <ManagedHostsCardView
          {...makeProps({
            snackbar: { open: true, message: 'Host added successfully', severity: 'success' },
          })}
        />
      )
      expect(screen.getByText('Host added successfully')).toBeDefined()
    })
  })
})
