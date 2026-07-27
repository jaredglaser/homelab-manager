import { describe, it, expect, mock } from 'bun:test'
import { render, screen } from '@testing-library/react'
import HostRow from '@/components/settings/HostRow'
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

function renderRow(overrides?: Partial<HostListItem>) {
  return render(
    <HostRow
      host={makeHost(overrides)}
      isChecking={false}
      isRemoving={false}
      onHealthCheck={mock(() => {})}
      onEdit={mock(() => {})}
      onRemove={mock(() => {})}
    />,
  )
}

describe('HostRow action buttons', () => {
  it('grows to the touch target size below the lg breakpoint and shrinks back above it', () => {
    renderRow()
    for (const label of ['check health', 'edit host', 'remove host']) {
      const button = screen.getByLabelText(label)
      expect(button.classList.contains('size-11')).toBe(true)
      expect(button.classList.contains('lg:size-8')).toBe(true)
    }
  })
})
