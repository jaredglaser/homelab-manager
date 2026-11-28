import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { VIEWER_DENIED_COPY } from '@/hooks/useAuth'
import { findOpenTooltip, seedSession } from '@/lib/test/session'
import { setupUser } from '@/lib/test/user-event'
import type { ZfsNodeSummary } from '@/lib/zfs/node-state'
import { formatNoticeTime } from '@/lib/zfs/node-state'
import { DEFAULT_SETTINGS } from '@/hooks/settingsAtom'
import type { CreateZfsNodeResult, ScanZfsNodeResult, VerifyZfsNodeResult } from '@/data/zfs/handlers'

const FINGERPRINT = 'SHA256:96sjJIA4izdxRnnHp5TcRvboMBPu3SZeyP7fywlMOgQ'
const lastData = new Date(2026, 10, 27, 10, 42).getTime()

function makeNode(overrides: Partial<ZfsNodeSummary> = {}): ZfsNodeSummary {
  return {
    id: 1,
    name: 'pve1',
    address: '192.168.1.10',
    port: 22,
    allowedFrom: null,
    state: 'ok',
    hostKeyFingerprint: FINGERPRINT,
    seenHostKeyFingerprint: null,
    lastSuccessAt: lastData,
    ...overrides,
  }
}

let nodes: ZfsNodeSummary[] = []
let createResult: CreateZfsNodeResult
let scanResult: ScanZfsNodeResult
let confirmResult: VerifyZfsNodeResult
let verifyResult: VerifyZfsNodeResult
const calls: { fn: string; data: unknown }[] = []
const failing = new Set<string>()
const record = <T,>(fn: string, value: () => T) => (args?: { data?: unknown }) => {
  calls.push({ fn, data: args?.data })
  if (failing.has(fn)) return Promise.reject(new Error(`${fn} failed on the server`))
  return Promise.resolve(value())
}

mock.module('@/data/zfs/functions', () => ({
  listZfsNodes: record('listZfsNodes', () => nodes),
  createZfsNode: record('createZfsNode', () => createResult),
  scanZfsNodeHostKey: record('scanZfsNodeHostKey', () => scanResult),
  confirmZfsNodeHostKey: record('confirmZfsNodeHostKey', () => confirmResult),
  verifyZfsNode: record('verifyZfsNode', () => verifyResult),
  removeZfsNode: record('removeZfsNode', () => ({ removed: true })),
  getZfsNodeSetupScript: record('getZfsNodeSetupScript', () => ({ setupScript: '#!/bin/sh\necho stored script\n' })),
}))

const showToast = mock<(message: string, severity: string) => void>()
mock.module('@/hooks/toastAtom', () => ({ useToast: () => ({ showToast }) }))

async function renderCard() {
  const { default: ZfsNodesCard } = await import('@/components/zfs-nodes/ZfsNodesCard')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ZfsNodesCard />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  seedSession('admin')
  nodes = []
  calls.length = 0
  failing.clear()
  showToast.mockClear()
  createResult = { ok: true, node: makeNode({ state: 'pending', hostKeyFingerprint: null, lastSuccessAt: null }), setupScript: '#!/bin/sh\necho setup\n' }
  scanResult = { ok: true, fingerprint: FINGERPRINT, confirmed: false }
  confirmResult = { ok: true, pools: ['rpool', 'tank'] }
  verifyResult = { ok: true, pools: ['rpool', 'tank'] }
})

describe('ZfsNodesCard', () => {
  it('shows each state notice on its node row', async () => {
    nodes = [
      makeNode({ state: 'unreachable' }),
      makeNode({ id: 2, name: 'pve2', state: 'host_key_changed', seenHostKeyFingerprint: 'SHA256:new' }),
      makeNode({ id: 3, name: 'pve3', state: 'key_refused' }),
      makeNode({ id: 4, name: 'pve4', state: 'ok' }),
    ]
    await renderCard()
    expect((await screen.findByTestId('zfs-node-notice-pve1')).textContent).toBe(
      `Can't reach pve1 over SSH on port 22. Showing the last data, from ${formatNoticeTime(lastData, DEFAULT_SETTINGS.general.use12HourTime)}.`,
    )
    expect(screen.getByTestId('zfs-node-notice-pve2').textContent).toBe(
      "pve2's host key changed, so collection stopped. If you reinstalled the node, confirm the new key on the Hosts page. If not, something may be impersonating it.",
    )
    expect(screen.getByTestId('zfs-node-notice-pve3').textContent).toBe("pve3 refused the app's key. Run the setup script on the node again.")
    expect(screen.queryByTestId('zfs-node-notice-pve4')).toBeNull()
    expect(screen.getByLabelText('Confirm host key of pve2')).toBeDefined()
    expect(screen.queryByLabelText('Confirm host key of pve4')).toBeNull()
  })

  it('walks through adding a node: details, setup script, host key confirm, connected', async () => {
    await renderCard()
    const user = setupUser()
    await user.click(await screen.findByText('Add ZFS node'))
    await user.type(screen.getByLabelText('Name'), 'pve1')
    await user.type(screen.getByLabelText('Address'), '192.168.1.10')
    await user.type(screen.getByLabelText('Worker address (optional)'), '192.168.1.5')
    await user.click(screen.getByText('Next'))

    expect((await screen.findByTestId('zfs-setup-intro')).textContent).toBe(
      "Run this on the node as root. It adds a user named hlm that can read your pools but cannot change them, and allows only this app's key to run two read-only ZFS commands.",
    )
    expect(screen.getByTestId('zfs-setup-script').textContent).toBe('#!/bin/sh\necho setup\n')
    expect(calls.find((call) => call.fn === 'createZfsNode')?.data).toEqual({ name: 'pve1', address: '192.168.1.10', port: 22, allowedFrom: '192.168.1.5' })

    await user.click(screen.getByText('I ran it, connect'))
    expect((await screen.findByTestId('zfs-host-key-confirm')).textContent).toBe(
      `Confirm this is pve1's host key: ${FINGERPRINT} Compare it with the output of the last line of the setup script.`,
    )
    await user.click(screen.getByText('Confirm'))
    expect((await screen.findByTestId('zfs-node-connected')).textContent).toBe('Connected to pve1. Found 2 pools: rpool, tank.')
    expect(calls.find((call) => call.fn === 'confirmZfsNodeHostKey')?.data).toEqual({ id: 1, fingerprint: FINGERPRINT })
  })

  it('tells the user when the name is taken, and stays on the form', async () => {
    createResult = { ok: false, code: 'name_taken' }
    await renderCard()
    const user = setupUser()
    await user.click(await screen.findByText('Add ZFS node'))
    await user.type(screen.getByLabelText('Name'), 'pve1')
    await user.type(screen.getByLabelText('Address'), 'pve1.lan')
    await user.click(screen.getByText('Next'))
    expect((await screen.findByRole('alert')).textContent).toBe('A ZFS node with this name already exists. Pick another name.')
  })

  it.each([
    ['key_refused', "pve1 refused the app's key. Run the setup script on the node again."],
    ['influxdb_missing', 'pve1 is missing zpool_influxdb, which comes with ZFS. Update the zfsutils-linux package on the node.'],
    ['unreachable', "Can't reach pve1 over SSH on port 22."],
  ] as const)('shows the %s failure on the verify step', async (failure, message) => {
    confirmResult = { ok: false, failure, fingerprint: null }
    await renderCard()
    const user = setupUser()
    await user.click(await screen.findByText('Add ZFS node'))
    await user.type(screen.getByLabelText('Name'), 'pve1')
    await user.type(screen.getByLabelText('Address'), 'pve1.lan')
    await user.click(screen.getByText('Next'))
    await user.click(await screen.findByText('I ran it, connect'))
    await user.click(await screen.findByText('Confirm'))
    expect((await screen.findByTestId('zfs-node-verify-failure')).textContent).toBe(message)
  })

  it('confirms a changed host key from the node row with a fresh read of the key', async () => {
    nodes = [makeNode({ state: 'host_key_changed', seenHostKeyFingerprint: 'SHA256:stale' })]
    await renderCard()
    const user = setupUser()
    await user.click(await screen.findByLabelText('Confirm host key of pve1'))
    expect((await screen.findByTestId('zfs-host-key-confirm')).textContent).toContain(FINGERPRINT)
    await user.click(screen.getByText('Confirm'))
    expect(await screen.findByTestId('zfs-node-connected')).toBeDefined()
    expect(calls.filter((call) => call.fn === 'scanZfsNodeHostKey')).toHaveLength(1)
  })

  it('checks a node again and shows the result on its row', async () => {
    nodes = [makeNode({ state: 'unreachable' })]
    verifyResult = { ok: false, failure: 'unreachable', fingerprint: null }
    await renderCard()
    const user = setupUser()
    await user.click(await screen.findByLabelText('Check pve1 again'))
    const row = screen.getByTestId('zfs-node-row-pve1')
    expect((await within(row).findByRole('status')).textContent).toBe("Can't reach pve1 over SSH on port 22.")
  })

  it('shows the stored setup script again', async () => {
    nodes = [makeNode({ state: 'key_refused' })]
    await renderCard()
    const user = setupUser()
    await user.click(await screen.findByLabelText('Show setup script for pve1'))
    expect((await screen.findByTestId('zfs-setup-script')).textContent).toBe('#!/bin/sh\necho stored script\n')
  })

  it('removes a node after a confirm that says what happens to it', async () => {
    nodes = [makeNode()]
    await renderCard()
    const user = setupUser()
    await user.click(await screen.findByLabelText('Remove pve1'))
    expect(screen.getByText("Remove pve1? Collection stops at once and its stored history is kept. To revoke the app's key on the node, run userdel hlm there.")).toBeDefined()
    await user.click(screen.getByText('Remove'))
    await waitFor(() => expect(calls.some((call) => call.fn === 'removeZfsNode')).toBe(true))
    expect(calls.find((call) => call.fn === 'removeZfsNode')?.data).toEqual({ id: 1 })
  })

  it('lets a viewer read the nodes but not add, confirm or remove them', async () => {
    seedSession('viewer')
    nodes = [makeNode({ state: 'host_key_changed' })]
    await renderCard()
    const user = setupUser()
    expect(await screen.findByTestId('zfs-node-notice-pve1')).toBeDefined()
    for (const label of ['Confirm host key of pve1', 'Show setup script for pve1', 'Check pve1 again', 'Remove pve1']) {
      expect(screen.getByLabelText(label).getAttribute('aria-disabled')).toBe('true')
    }
    await user.click(screen.getByLabelText('Remove pve1'))
    expect(await findOpenTooltip()).toBe(VIEWER_DENIED_COPY)
    expect(calls.map((call) => call.fn)).toEqual(['listZfsNodes'])
  })

  it('shows the list failure and the empty state in words the user can act on', async () => {
    failing.add('listZfsNodes')
    const { unmount } = await renderCard()
    expect(await screen.findByText('The ZFS node list could not be fetched. Check the server logs and reload the page.')).toBeDefined()
    unmount()
    failing.clear()
    await renderCard()
    expect(await screen.findByText('No ZFS nodes yet. Add one to read its pools over SSH.')).toBeDefined()
  })

  it('says the node could not be added when the add call fails', async () => {
    failing.add('createZfsNode')
    await renderCard()
    const user = setupUser()
    await user.click(await screen.findByText('Add ZFS node'))
    await user.type(screen.getByLabelText('Name'), 'pve1')
    await user.type(screen.getByLabelText('Address'), 'pve1.lan')
    await user.click(screen.getByText('Next'))
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't add the node. Reload the page and try again.")
  })

  it('says the node could not be checked when the connect call fails, and offers to try again', async () => {
    failing.add('scanZfsNodeHostKey')
    await renderCard()
    const user = setupUser()
    await user.click(await screen.findByText('Add ZFS node'))
    await user.type(screen.getByLabelText('Name'), 'pve1')
    await user.type(screen.getByLabelText('Address'), 'pve1.lan')
    await user.click(screen.getByText('Next'))
    await user.click(await screen.findByText('I ran it, connect'))
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't check the node. Reload the page and try again.")
    expect(screen.getByText('Try again')).toBeDefined()
  })

  it('says the node was removed when the connect step finds it gone', async () => {
    scanResult = { ok: false, failure: 'not_found' }
    await renderCard()
    const user = setupUser()
    await user.click(await screen.findByText('Add ZFS node'))
    await user.type(screen.getByLabelText('Name'), 'pve1')
    await user.type(screen.getByLabelText('Address'), 'pve1.lan')
    await user.click(screen.getByText('Next'))
    await user.click(await screen.findByText('I ran it, connect'))
    expect((await screen.findByTestId('zfs-node-verify-failure')).textContent).toBe('This node was removed. Close this window and add it again.')
  })

  it.each([
    ['verifyZfsNode', 'Check pve1 again', "Couldn't check the node. Reload the page and try again."],
    ['removeZfsNode', 'Remove pve1', "Couldn't remove the node. Reload the page and try again."],
  ] as const)('toasts a failed %s call', async (fn, label, message) => {
    failing.add(fn)
    nodes = [makeNode()]
    await renderCard()
    const user = setupUser()
    await user.click(await screen.findByLabelText(label))
    if (fn === 'removeZfsNode') await user.click(screen.getByText('Remove'))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(message, 'error'))
  })

  it('says the setup script could not be loaded', async () => {
    failing.add('getZfsNodeSetupScript')
    nodes = [makeNode({ state: 'key_refused' })]
    await renderCard()
    const user = setupUser()
    await user.click(await screen.findByLabelText('Show setup script for pve1'))
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't load the setup script. Reload the page and try again.")
  })
})
