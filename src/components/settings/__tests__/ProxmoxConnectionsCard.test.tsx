import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { render, screen, waitFor, within } from '@testing-library/react'
import '@/lib/test/testing-library'
import { setupUser } from '@/lib/test/user-event'
import { findOpenTooltip, roleReasonOf, seedSession } from '@/lib/test/session'
import { ProxmoxConnectionsCardView, type ProxmoxConnectionsCardViewProps } from '../ProxmoxConnectionsCard'
import type { TestProxmoxConnectionResult } from '@/data/proxmox/connection-handlers'
import type { ProxmoxCollectorStateView, ProxmoxConnectionSummary } from '@/types/proxmox'

const W1 = ['Address', 'Port', 'Token ID (user@realm!token)', 'Token secret', 'Allow self-signed certificate']
const W2 = 'Stored encrypted. Leave blank to keep the current secret.'
const W3 = 'Connected to homelab (Proxmox VE 9.0), 2 nodes.'
const W8 = 'Remove homelab? Its history stays, but no new stats are collected.'
const W9 = 'Only admins can change Proxmox connections.'

const saved: ProxmoxConnectionSummary = {
  id: 1,
  name: 'homelab',
  address: 'pve.lan',
  port: 8006,
  tokenId: 'root@pam!hlm',
  allowSelfSignedCerts: true,
}

function state(overrides: Partial<ProxmoxCollectorStateView> = {}): ProxmoxCollectorStateView {
  return { connectionId: '1', host: 'pve.lan', port: 8006, state: 'collecting', lastSuccessAt: null, updatedAt: 0, ...overrides }
}

const reached: TestProxmoxConnectionResult = { ok: true, clusterName: 'homelab', release: '9.0', nodeCount: 2 }

function renderCard(overrides: Partial<ProxmoxConnectionsCardViewProps> = {}) {
  const props: ProxmoxConnectionsCardViewProps = {
    connections: [saved],
    isLoading: false,
    states: { connections: [state()] },
    onTest: mock(async () => reached),
    onSave: mock(async () => null),
    onRemove: mock(async () => {}),
    ...overrides,
  }
  render(<ProxmoxConnectionsCardView {...props} />)
  return props
}

async function fillNewConnection(user: ReturnType<typeof setupUser>, secret = 'wrong-secret') {
  await user.click(screen.getByRole('button', { name: 'Add cluster' }))
  const dialog = await screen.findByRole('dialog')
  await user.type(within(dialog).getByLabelText('Address'), 'pve.lan')
  await user.type(within(dialog).getByLabelText('Token ID (user@realm!token)'), 'root@pam!hlm')
  await user.type(within(dialog).getByLabelText('Token secret'), secret)
  return dialog
}

describe('ProxmoxConnectionsCardView', () => {
  beforeEach(() => seedSession('admin'))

  it('labels the form fields with the accepted copy, and shows the keep-secret hint only when editing', async () => {
    renderCard()
    const user = setupUser()

    await user.click(screen.getByRole('button', { name: 'Add cluster' }))
    const add = await screen.findByRole('dialog')
    for (const label of W1) expect(within(add).getByText(label)).toBeInTheDocument()
    expect(within(add).queryByText(W2)).toBeNull()
    await user.click(within(add).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await user.click(screen.getByRole('button', { name: 'Edit homelab' }))
    const edit = await screen.findByRole('dialog')
    expect(within(edit).getByText(W2)).toBeInTheDocument()
    expect(within(edit).getByLabelText('Address')).toHaveValue('pve.lan')
    expect(within(edit).getByLabelText('Token secret')).toHaveValue('')
  })

  it('saves a new connection without testing it first, with no name so the server names it after the address', async () => {
    const props = renderCard({ connections: [] })
    const user = setupUser()
    const dialog = await fillNewConnection(user)

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(1))
    expect(props.onTest).not.toHaveBeenCalled()
    expect(props.onSave).toHaveBeenCalledWith({
      address: 'pve.lan', port: 8006, tokenId: 'root@pam!hlm', tokenSecret: 'wrong-secret', allowSelfSignedCerts: true,
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('shows the cluster it reached, and saves under that cluster name', async () => {
    const props = renderCard({ connections: [] })
    const user = setupUser()
    const dialog = await fillNewConnection(user, 'right-secret')

    await user.click(within(dialog).getByRole('button', { name: 'Test connection' }))
    expect(await within(dialog).findByText(W3)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(1))
    expect((props.onSave as ReturnType<typeof mock>).mock.calls[0][0]).toMatchObject({ name: 'homelab' })
  })

  it.each([
    ['unreachable', "Couldn't reach pve.lan on port 8006. Check the address and that the port is open from the server running Homelab Manager."],
    ['token_rejected', 'Proxmox rejected the token. Check the token ID and secret.'],
    ['certificate_refused', "Proxmox's certificate isn't trusted. Turn on \"Allow self-signed certificate\" or give Proxmox a trusted certificate."],
  ] as const)('words a %s test failure for the user', async (code, message) => {
    renderCard({ connections: [], onTest: mock(async () => ({ ok: false as const, code })) })
    const user = setupUser()
    const dialog = await fillNewConnection(user)

    await user.click(within(dialog).getByRole('button', { name: 'Test connection' }))

    expect(await within(dialog).findByText(message)).toBeInTheDocument()
  })

  it('edits a connection with the secret left blank, so the stored one is kept', async () => {
    const props = renderCard()
    const user = setupUser()
    await user.click(screen.getByRole('button', { name: 'Edit homelab' }))
    const dialog = await screen.findByRole('dialog')
    await user.clear(within(dialog).getByLabelText('Port'))
    await user.type(within(dialog).getByLabelText('Port'), '8007')

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(1))
    expect(props.onSave).toHaveBeenCalledWith({
      id: 1, address: 'pve.lan', port: 8007, tokenId: 'root@pam!hlm', tokenSecret: '', allowSelfSignedCerts: true,
    })
  })

  it('keeps the name of an edited connection whose address is unchanged', async () => {
    const props = renderCard()
    const user = setupUser()
    await user.click(screen.getByRole('button', { name: 'Edit homelab' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('switch', { name: 'Allow self-signed certificate' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(1))
    expect((props.onSave as ReturnType<typeof mock>).mock.calls[0][0]).toMatchObject({ name: 'homelab', allowSelfSignedCerts: false })
  })

  it('keeps the form open with the reason when the save is refused', async () => {
    renderCard({ connections: [], onSave: mock(async () => 'A Proxmox connection to pve.lan already exists.') })
    const user = setupUser()
    const dialog = await fillNewConnection(user)

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await within(dialog).findByText('A Proxmox connection to pve.lan already exists.')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('refuses an address with a scheme and a secret with a space before anything is sent', async () => {
    const props = renderCard({ connections: [] })
    const user = setupUser()
    await user.click(screen.getByRole('button', { name: 'Add cluster' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Address'), 'https://pve.lan')
    await user.type(within(dialog).getByLabelText('Token ID (user@realm!token)'), 'root@pam!hlm')
    await user.type(within(dialog).getByLabelText('Token secret'), 'ünicode')

    expect(within(dialog).getByText('Enter a host name or IP address, without https:// or a port.')).toBeInTheDocument()
    expect(within(dialog).getByText('Use only letters, digits and symbols, with no spaces.')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Test connection' })).toBeDisabled()
    await user.keyboard('{Enter}')
    expect(props.onSave).not.toHaveBeenCalled()
  })

  it('shows the worker state next to a passing test, so a worker that cannot reach Proxmox stays visible', async () => {
    renderCard({ states: { connections: [state({ state: 'unreachable' })] } })
    const user = setupUser()
    expect(screen.getByText("Can't reach Proxmox at pve.lan:8006.")).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Edit homelab' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Test connection' }))
    expect(await within(dialog).findByText(W3)).toBeInTheDocument()

    expect(screen.getByText("Can't reach Proxmox at pve.lan:8006.")).toBeInTheDocument()
  })

  it.each([
    ['collecting', 'Collecting'],
    ['token_rejected', 'Proxmox rejected the API token. Check the token ID and secret, and that the token can read the cluster.'],
    ['certificate_refused', "Proxmox's certificate isn't trusted. Allow self-signed certificates for this connection, or give Proxmox a trusted certificate."],
  ] as const)('shows the worker state %s on the row', (kind, text) => {
    renderCard({ states: { connections: [state({ state: kind })] } })
    expect(screen.getByText(text)).toBeInTheDocument()
  })

  it('asks before removing, in the accepted words, and removes on confirm', async () => {
    const props = renderCard()
    const user = setupUser()

    await user.click(screen.getByRole('button', { name: 'Remove homelab' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(W8)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(props.onRemove).toHaveBeenCalledWith(saved))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('says so when no cluster is added', () => {
    renderCard({ connections: [], states: { connections: [] } })
    expect(screen.getByText('No Proxmox cluster added yet.')).toBeInTheDocument()
  })

  it.each(['viewer', 'operator'] as const)('shows a %s the connection but every change disabled, with the admin-only reason', async (role) => {
    seedSession(role)
    const props = renderCard()
    const user = setupUser()

    expect(screen.getByText('homelab')).toBeInTheDocument()
    for (const name of ['Add cluster', 'Edit homelab', 'Remove homelab']) {
      const button = screen.getByRole('button', { name })
      expect(button.getAttribute('aria-disabled')).toBe('true')
      expect(roleReasonOf(button)).toBe(W9)
      await user.click(button)
    }
    await user.hover(screen.getByRole('button', { name: 'Add cluster' }))
    expect(await findOpenTooltip()).toBe(W9)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(props.onRemove).not.toHaveBeenCalled()
  })
})
