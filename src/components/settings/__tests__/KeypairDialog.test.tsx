import { describe, it, expect, mock } from 'bun:test'
import { render, screen, fireEvent } from '@testing-library/react'
import '@/lib/test/testing-library'
import { KeypairDialog } from '@/components/settings/KeypairDialog'
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
    autoUpdate: false,
    status: 'healthy',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const OLD_JWK = JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'old-x' })
const NEW_JWK = JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'new-x' })

function makeProps(overrides?: Partial<Parameters<typeof KeypairDialog>[0]>) {
  return {
    open: true,
    host: makeHost(),
    publicJwkJson: OLD_JWK,
    isLoading: false,
    isRotating: false,
    onView: mock(() => {}),
    onRotate: mock(() => {}),
    onClose: mock(() => {}),
    ...overrides,
  }
}

describe('KeypairDialog', () => {
  it('requires two clicks to rotate', () => {
    const onRotate = mock(() => {})
    render(<KeypairDialog {...makeProps({ onRotate })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Rotate keypair' }))
    expect(onRotate).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Confirm rotation' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm rotation' }))
    expect(onRotate).toHaveBeenCalledTimes(1)
  })

  it('exits the confirm state and shows a success alert when the rotated key arrives', () => {
    const { rerender } = render(<KeypairDialog {...makeProps()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Rotate keypair' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm rotation' }))

    rerender(<KeypairDialog {...makeProps({ publicJwkJson: NEW_JWK })} />)

    expect(screen.getByText(/Keypair rotated/)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Confirm rotation' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Rotate keypair' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Close' })).toBeDefined()
  })

  it('offers no way to rotate again until the dialog is reopened', () => {
    const onRotate = mock(() => {})
    const { rerender } = render(<KeypairDialog {...makeProps({ onRotate })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Rotate keypair' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm rotation' }))
    rerender(<KeypairDialog {...makeProps({ onRotate, publicJwkJson: NEW_JWK })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onRotate).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /rotate/i })).toBeNull()
  })

  it('resets the rotated state when the dialog reopens', () => {
    const { rerender } = render(<KeypairDialog {...makeProps()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Rotate keypair' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm rotation' }))
    rerender(<KeypairDialog {...makeProps({ publicJwkJson: NEW_JWK })} />)
    expect(screen.queryByRole('button', { name: 'Rotate keypair' })).toBeNull()

    rerender(<KeypairDialog {...makeProps({ open: false, publicJwkJson: NEW_JWK })} />)
    rerender(<KeypairDialog {...makeProps({ publicJwkJson: NEW_JWK })} />)

    expect(screen.queryByText(/Keypair rotated/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Rotate keypair' })).toBeDefined()
  })
})
