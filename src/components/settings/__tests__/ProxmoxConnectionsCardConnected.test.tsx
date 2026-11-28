import { describe, it, expect, mock, beforeEach, spyOn } from 'bun:test'
import { createElement, type ReactNode } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/lib/test/testing-library'
import { setupUser } from '@/lib/test/user-event'
import { seedSession } from '@/lib/test/session'
import { mockModule } from '@/lib/test/mock-module'
import { FakeMuxConnection } from '@/lib/test/fake-mux'
import type * as ProxmoxFunctions from '@/data/proxmox/functions'
import type * as ToastAtom from '@/hooks/toastAtom'
import type * as MuxConnection from '@/lib/mux/mux-connection'
import type { SaveProxmoxConnectionResult } from '@/data/proxmox/connection-handlers'
import type { ProxmoxConnectionSummary } from '@/types/proxmox'

const showToast = mock<(message: string, severity: string) => void>(() => undefined)
mockModule<typeof ToastAtom>('@/hooks/toastAtom', (real) => ({ ...real, useToast: () => ({ showToast }) }))

const fakeMux = new FakeMuxConnection()
mockModule<typeof MuxConnection>('@/lib/mux/mux-connection', (real) => ({ ...real, muxConnection: fakeMux }))

const saved: ProxmoxConnectionSummary = { id: 1, name: 'homelab', address: 'pve.lan', port: 8006, tokenId: 'root@pam!hlm', allowSelfSignedCerts: true }
let saveAnswer: () => Promise<SaveProxmoxConnectionResult> = () => Promise.resolve({ ok: true, connection: saved })
let removeAnswer: () => Promise<{ removed: boolean }> = () => Promise.resolve({ removed: true })
const list = mock(() => Promise.resolve([saved]))

mockModule<typeof ProxmoxFunctions>('@/data/proxmox/functions', (real) => ({
  ...real,
  listProxmoxConnections: list,
  saveProxmoxConnection: (() => saveAnswer()),
  testProxmoxConnection: (() => Promise.resolve({ ok: true, clusterName: 'homelab', release: '9.0', nodeCount: 2 })),
  removeProxmoxConnection: (() => removeAnswer()),
}))

const { ProxmoxConnectionsCard } = await import('../ProxmoxConnectionsCard')

let queryClient: QueryClient

function renderCard() {
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children)
  render(<ProxmoxConnectionsCard />, { wrapper })
}

async function editAndSave(user: ReturnType<typeof setupUser>) {
  await user.click(await screen.findByRole('button', { name: 'Edit homelab' }))
  const dialog = await screen.findByRole('dialog')
  await user.click(within(dialog).getByRole('button', { name: 'Save' }))
  return dialog
}

describe('ProxmoxConnectionsCard', () => {
  beforeEach(() => {
    seedSession('admin')
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    fakeMux.subscriptions.clear()
    fakeMux.status = { connected: true, error: null }
    showToast.mockClear()
    list.mockClear()
    saveAnswer = () => Promise.resolve({ ok: true, connection: saved })
    removeAnswer = () => Promise.resolve({ removed: true })
  })

  it('shows the worker state from the live topic on the row', async () => {
    renderCard()
    await screen.findByText('homelab')
    act(() => fakeMux.emitWire('proxmox-state', 'data', {
      connections: [{ connectionId: '1', host: 'pve.lan', port: 8006, state: 'token_rejected', lastSuccessAt: null, updatedAt: 0 }],
    }))

    expect(await screen.findByText('Proxmox rejected the API token. Check the token ID and secret, and that the token can read the cluster.')).toBeDefined()
  })

  it('toasts the accepted message after a save and reloads the list', async () => {
    renderCard()
    const user = setupUser()
    await editAndSave(user)

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Proxmox cluster saved. Stats start within a few seconds.', 'success'))
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(1))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('keeps the form open with the reason for an address another connection uses', async () => {
    saveAnswer = () => Promise.resolve({ ok: false, code: 'address_taken' })
    renderCard()
    const user = setupUser()
    const dialog = await editAndSave(user)

    expect(await within(dialog).findByText('A Proxmox connection to pve.lan already exists.')).toBeDefined()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('words a save that fails outright, and logs the cause', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    saveAnswer = () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.2:5432'))
    try {
      renderCard()
      const user = setupUser()
      const dialog = await editAndSave(user)

      expect(await within(dialog).findByText("Couldn't save the Proxmox connection. Try again.")).toBeDefined()
      expect(within(dialog).queryByText(/ECONNREFUSED/)).toBeNull()
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('toasts a removal that fails', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    removeAnswer = () => Promise.reject(new Error('boom'))
    try {
      renderCard()
      const user = setupUser()
      await user.click(await screen.findByRole('button', { name: 'Remove homelab' }))
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }))

      await waitFor(() => expect(showToast).toHaveBeenCalledWith("Couldn't remove homelab. Try again.", 'error'))
    } finally {
      errorSpy.mockRestore()
    }
  })
})
