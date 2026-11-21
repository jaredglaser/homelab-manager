import { describe, it, expect, mock } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { setupUser, activateWithKey } from '@/lib/test/user-event'
import '@/lib/test/testing-library'
import { RemoveDialog, EditDialog } from '@/components/settings/HostDialogs'
import type { HostListItem } from '@/lib/hosts/host-utils'

function makeHost(overrides?: Partial<HostListItem>): HostListItem {
  return {
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
  }
}

describe('RemoveDialog', () => {
  const defaultProps = {
    open: true,
    hostName: 'server1',
    isRemoving: false,
    onConfirm: mock(() => {}),
    onClose: mock(() => {}),
  }

  it('renders the host name in the dialog content', () => {
    render(<RemoveDialog {...defaultProps} />)
    expect(screen.getByText('server1')).toBeDefined()
  })

  it('renders Remove Host title', () => {
    render(<RemoveDialog {...defaultProps} />)
    expect(screen.getByText('Remove Host')).toBeDefined()
  })

  it('calls onConfirm when Remove button is clicked', async () => {
    const user = setupUser()
    const onConfirm = mock(() => {})
    render(<RemoveDialog {...defaultProps} onConfirm={onConfirm} />)
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('calls onConfirm when Remove is activated from the keyboard', async () => {
    const user = setupUser()
    const onConfirm = mock(() => {})
    render(<RemoveDialog {...defaultProps} onConfirm={onConfirm} />)
    await activateWithKey(user, screen.getByRole('button', { name: 'Remove' }), '{Enter}')
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when Cancel button is clicked', async () => {
    const user = setupUser()
    const onClose = mock(() => {})
    render(<RemoveDialog {...defaultProps} onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('disables Remove and Cancel buttons while isRemoving', () => {
    render(<RemoveDialog {...defaultProps} isRemoving={true} />)
    const cancelBtn = screen.getByRole('button', { name: 'Cancel' })
    expect(cancelBtn.hasAttribute('disabled')).toBe(true)
    // Remove button shows CircularProgress; the button itself is disabled
    const buttons = screen.getAllByRole('button')
    const removeBtn = buttons.find((b) => b !== cancelBtn)
    expect(removeBtn?.hasAttribute('disabled')).toBe(true)
  })

  it('calls onClose when Escape is pressed', async () => {
    const user = setupUser()
    const onClose = mock(() => {})
    render(<RemoveDialog {...defaultProps} onClose={onClose} />)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not call onConfirm while isRemoving', async () => {
    const user = setupUser()
    const onConfirm = mock(() => {})
    render(<RemoveDialog {...defaultProps} isRemoving={true} onConfirm={onConfirm} />)
    const cancelBtn = screen.getByRole('button', { name: 'Cancel' })
    await user.click(screen.getAllByRole('button').find((b) => b !== cancelBtn)!)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('does not render when open is false', () => {
    render(<RemoveDialog {...defaultProps} open={false} />)
    expect(screen.queryByText('Remove Host')).toBeNull()
  })

  it('shows the warning about deploy history deletion', () => {
    render(<RemoveDialog {...defaultProps} />)
    expect(screen.getByText(/delete all deploy history/)).toBeDefined()
  })
})

describe('EditDialog', () => {
  const defaultProps = {
    open: true,
    host: makeHost(),
    isUpdating: false,
    onConfirm: mock(() => {}),
    onClose: mock(() => {}),
  }

  it('renders Edit Host title', () => {
    render(<EditDialog {...defaultProps} />)
    expect(screen.getByText('Edit Host')).toBeDefined()
  })

  it('pre-fills Host Name field from host prop', () => {
    render(<EditDialog {...defaultProps} />)
    const nameInput = screen.getByLabelText('Edit Host Name') as HTMLInputElement
    expect(nameInput.value).toBe('server1')
  })

  it('pre-fills Agent URL field from host prop', () => {
    render(<EditDialog {...defaultProps} />)
    const urlInput = screen.getByLabelText('Edit Agent URL') as HTMLInputElement
    expect(urlInput.value).toBe('http://192.168.1.10:9090')
  })

  it('Save button is enabled when both fields have values', () => {
    render(<EditDialog {...defaultProps} />)
    const saveBtn = screen.getByRole('button', { name: 'Save' })
    expect(saveBtn.hasAttribute('disabled')).toBe(false)
  })

  it('renders the Host Name field as read-only', () => {
    render(<EditDialog {...defaultProps} />)
    const nameInput = screen.getByLabelText('Edit Host Name') as HTMLInputElement
    expect(nameInput.disabled).toBe(true)
  })

  it('shows helper text explaining the name is fixed', () => {
    render(<EditDialog {...defaultProps} />)
    expect(screen.getByText(/fixed after enrollment/i)).toBeDefined()
  })

  it('keeps Save enabled even though the name field cannot be edited', () => {
    render(<EditDialog {...defaultProps} />)
    const saveBtn = screen.getByRole('button', { name: 'Save' })
    expect(saveBtn.hasAttribute('disabled')).toBe(false)
  })

  it('Save button is disabled when Agent URL is cleared', async () => {
    const user = setupUser()
    render(<EditDialog {...defaultProps} />)
    await user.clear(screen.getByLabelText('Edit Agent URL'))
    const saveBtn = screen.getByRole('button', { name: 'Save' })
    expect(saveBtn.hasAttribute('disabled')).toBe(true)
  })

  it('Save button is disabled when Agent URL is whitespace-only', async () => {
    const user = setupUser()
    render(<EditDialog {...defaultProps} />)
    await user.clear(screen.getByLabelText('Edit Agent URL'))
    await user.type(screen.getByLabelText('Edit Agent URL'), '   ')
    const saveBtn = screen.getByRole('button', { name: 'Save' })
    expect(saveBtn.hasAttribute('disabled')).toBe(true)
  })

  it('calls onConfirm with hostId, the unchanged host name, and trimmed agentUrl', async () => {
    const user = setupUser()
    const onConfirm = mock(() => {})
    render(<EditDialog {...defaultProps} onConfirm={onConfirm} />)
    await user.clear(screen.getByLabelText('Edit Agent URL'))
    await user.type(screen.getByLabelText('Edit Agent URL'), '  http://10.0.0.1:9090  ')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith(1, 'server1', 'http://10.0.0.1:9090')
  })

  it('calls onConfirm when Save is activated from the keyboard', async () => {
    const user = setupUser()
    const onConfirm = mock(() => {})
    render(<EditDialog {...defaultProps} onConfirm={onConfirm} />)
    await activateWithKey(user, screen.getByRole('button', { name: 'Save' }), ' ')
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith(1, 'server1', 'http://192.168.1.10:9090')
  })

  it('saves against the id of the host it was given', async () => {
    const user = setupUser()
    const onConfirm = mock(() => {})
    render(<EditDialog {...defaultProps} host={makeHost({ id: 7, name: 'server7' })} onConfirm={onConfirm} />)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onConfirm).toHaveBeenCalledWith(7, 'server7', 'http://192.168.1.10:9090')
  })

  it('calls onClose when Cancel is clicked', async () => {
    const user = setupUser()
    const onClose = mock(() => {})
    render(<EditDialog {...defaultProps} onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('disables inputs and buttons while isUpdating', () => {
    render(<EditDialog {...defaultProps} isUpdating={true} />)
    const nameInput = screen.getByLabelText('Edit Host Name') as HTMLInputElement
    const urlInput = screen.getByLabelText('Edit Agent URL') as HTMLInputElement
    const cancelBtn = screen.getByRole('button', { name: 'Cancel' })
    expect(nameInput.disabled).toBe(true)
    expect(urlInput.disabled).toBe(true)
    expect(cancelBtn.hasAttribute('disabled')).toBe(true)
  })

  it('does not call onConfirm when there is no host, even with a URL typed in', async () => {
    const user = setupUser()
    const onConfirm = mock(() => {})
    render(<EditDialog {...defaultProps} host={null} onConfirm={onConfirm} />)
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
    await user.type(screen.getByLabelText('Edit Agent URL'), 'http://10.0.0.1:9090')
    const saveBtn = screen.getByRole('button', { name: 'Save' })
    expect(saveBtn.hasAttribute('disabled')).toBe(false)
    await user.click(saveBtn)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('does not call onConfirm when Save is clicked with a cleared URL', async () => {
    const user = setupUser()
    const onConfirm = mock(() => {})
    render(<EditDialog {...defaultProps} onConfirm={onConfirm} />)
    await user.clear(screen.getByLabelText('Edit Agent URL'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('disables the Save button and does not call onConfirm while isUpdating', async () => {
    const user = setupUser()
    const onConfirm = mock(() => {})
    render(<EditDialog {...defaultProps} isUpdating={true} onConfirm={onConfirm} />)
    const cancelBtn = screen.getByRole('button', { name: 'Cancel' })
    const saveBtn = screen.getAllByRole('button').find((b) => b !== cancelBtn)!
    expect(saveBtn.textContent).not.toBe('Save')
    expect(saveBtn.hasAttribute('disabled')).toBe(true)
    await user.click(saveBtn)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('calls onClose when Escape is pressed', async () => {
    const user = setupUser()
    const onClose = mock(() => {})
    render(<EditDialog {...defaultProps} onClose={onClose} />)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not render when open is false', () => {
    render(<EditDialog {...defaultProps} open={false} />)
    expect(screen.queryByText('Edit Host')).toBeNull()
  })

  it('resets fields when host prop changes', () => {
    const { rerender } = render(<EditDialog {...defaultProps} />)
    const newHost = makeHost({ id: 2, name: 'server2', agentUrl: 'http://10.0.0.2:9090' })
    rerender(<EditDialog {...defaultProps} host={newHost} />)
    const nameInput = screen.getByLabelText('Edit Host Name') as HTMLInputElement
    const urlInput = screen.getByLabelText('Edit Agent URL') as HTMLInputElement
    expect(nameInput.value).toBe('server2')
    expect(urlInput.value).toBe('http://10.0.0.2:9090')
  })
})
