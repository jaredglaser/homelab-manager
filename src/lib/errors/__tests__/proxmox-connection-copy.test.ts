import { describe, it, expect } from 'bun:test'
import {
  PROXMOX_ADMIN_ONLY,
  PROXMOX_CERTIFICATE_REFUSED_TEST,
  PROXMOX_COLLECTING,
  PROXMOX_CONNECTION_GONE,
  PROXMOX_FIELD_LABELS,
  PROXMOX_INVALID_ADDRESS,
  PROXMOX_INVALID_PORT,
  PROXMOX_INVALID_TOKEN,
  PROXMOX_NO_CONNECTIONS,
  PROXMOX_SAVED_TOAST,
  PROXMOX_SAVE_FAILED,
  PROXMOX_SECRET_KEPT_HINT,
  PROXMOX_TEST_FAILED,
  PROXMOX_TOKEN_REJECTED_TEST,
  proxmoxAddressTaken,
  proxmoxRemoveFailed,
  proxmoxRemoveQuestion,
  proxmoxSaveFailure,
  proxmoxTestMessage,
  proxmoxUnreachable,
} from '../proxmox-connection-copy'

describe('Proxmox connection copy', () => {
  it('pins the accepted messages w1 to w9 word for word', () => {
    expect(Object.values(PROXMOX_FIELD_LABELS).join(' · ')).toBe(
      'Address · Port · Token ID (user@realm!token) · Token secret · Allow self-signed certificate',
    )
    expect(PROXMOX_SECRET_KEPT_HINT).toBe('Stored encrypted. Leave blank to keep the current secret.')
    expect(proxmoxTestMessage({ ok: true, clusterName: 'homelab', release: '9.0', nodeCount: 2 }, 'pve.lan', 8006))
      .toBe('Connected to homelab (Proxmox VE 9.0), 2 nodes.')
    expect(proxmoxTestMessage({ ok: false, code: 'unreachable' }, 'pve.lan', 8006)).toBe(
      "Couldn't reach pve.lan on port 8006. Check the address and that the port is open from the server running Homelab Manager.",
    )
    expect(proxmoxTestMessage({ ok: false, code: 'token_rejected' }, 'pve.lan', 8006)).toBe('Proxmox rejected the token. Check the token ID and secret.')
    expect(proxmoxTestMessage({ ok: false, code: 'certificate_refused' }, 'pve.lan', 8006)).toBe(
      "Proxmox's certificate isn't trusted. Turn on \"Allow self-signed certificate\" or give Proxmox a trusted certificate.",
    )
    expect(PROXMOX_SAVED_TOAST).toBe('Proxmox cluster saved. Stats start within a few seconds.')
    expect(proxmoxRemoveQuestion('homelab')).toBe('Remove homelab? Its history stays, but no new stats are collected.')
    expect(PROXMOX_ADMIN_ONLY).toBe('Only admins can change Proxmox connections.')
    expect(PROXMOX_TOKEN_REJECTED_TEST).toBe(proxmoxTestMessage({ ok: false, code: 'token_rejected' }, 'x', 1))
    expect(PROXMOX_CERTIFICATE_REFUSED_TEST).toBe(proxmoxTestMessage({ ok: false, code: 'certificate_refused' }, 'x', 1))
    expect(proxmoxUnreachable('pve.lan', 8006)).toBe(proxmoxTestMessage({ ok: false, code: 'unreachable' }, 'pve.lan', 8006))
  })

  it('pins the copy that is not on the plan page', () => {
    expect(proxmoxTestMessage({ ok: true, clusterName: 'pve1', release: '8.2', nodeCount: 1 }, 'pve1.lan', 8006))
      .toBe('Connected to pve1 (Proxmox VE 8.2), 1 node.')
    expect(proxmoxTestMessage({ ok: false, code: 'not_found' }, 'pve.lan', 8006)).toBe(PROXMOX_CONNECTION_GONE)
    expect(PROXMOX_CONNECTION_GONE).toBe('This Proxmox connection was removed, maybe from another tab. Close this form and add it again.')
    expect(proxmoxSaveFailure({ ok: false, code: 'address_taken' }, 'pve.lan')).toBe('A Proxmox connection to pve.lan already exists.')
    expect(proxmoxAddressTaken('pve.lan')).toBe('A Proxmox connection to pve.lan already exists.')
    expect(proxmoxSaveFailure({ ok: false, code: 'not_found' }, 'pve.lan')).toBe(PROXMOX_CONNECTION_GONE)
    expect(PROXMOX_NO_CONNECTIONS).toBe('No Proxmox cluster added yet.')
    expect(PROXMOX_COLLECTING).toBe('Collecting')
    expect(PROXMOX_INVALID_ADDRESS).toBe('Enter a host name or IP address, without https:// or a port.')
    expect(PROXMOX_INVALID_PORT).toBe('Enter a port from 1 to 65535.')
    expect(PROXMOX_INVALID_TOKEN).toBe('Use only letters, digits and symbols, with no spaces.')
    expect(PROXMOX_SAVE_FAILED).toBe("Couldn't save the Proxmox connection. Try again.")
    expect(PROXMOX_TEST_FAILED).toBe("Couldn't run the test. Try again.")
    expect(proxmoxRemoveFailed('homelab')).toBe("Couldn't remove homelab. Try again.")
  })
})
