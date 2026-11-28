import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import {
  PROXMOX_CERTIFICATE_REFUSED,
  PROXMOX_COLLECTOR_OFF,
  PROXMOX_LIVE_CONNECTION_LOST,
  PROXMOX_NOT_SET_UP,
  PROXMOX_TOKEN_REJECTED,
  ProxmoxNoticeList,
  formatClockTime,
  proxmoxDataExpected,
  proxmoxStateNotices,
  unreachableMessage,
} from '../ProxmoxNotices';
import type { ProxmoxCollectorStateView } from '@/types/proxmox';

const at1042 = new Date(2026, 10, 27, 10, 42).getTime();

function connection(overrides: Partial<ProxmoxCollectorStateView>): ProxmoxCollectorStateView {
  return {
    connectionId: 'pve.lan',
    host: 'pve.lan',
    port: 8006,
    state: 'collecting',
    lastSuccessAt: at1042,
    updatedAt: at1042,
    ...overrides,
  };
}

describe('Proxmox notice copy', () => {
  it('pins the accepted messages word for word', () => {
    expect(PROXMOX_NOT_SET_UP).toBe("Proxmox isn't set up. Add your cluster in Settings, under Proxmox.");
    expect(PROXMOX_COLLECTOR_OFF).toBe(
      "The worker isn't collecting Proxmox stats. Set WORKER_PROXMOX_ENABLED=true on the worker container and restart it.",
    );
    expect(unreachableMessage(connection({}), false, true)).toBe(
      "Can't reach Proxmox at pve.lan:8006. Showing the last data, from 10:42.",
    );
    expect(PROXMOX_TOKEN_REJECTED).toBe(
      'Proxmox rejected the API token. Check the token ID and secret, and that the token can read the cluster.',
    );
    expect(PROXMOX_CERTIFICATE_REFUSED).toBe(
      "Proxmox's certificate isn't trusted. Allow self-signed certificates for this connection, or give Proxmox a trusted certificate.",
    );
    expect(PROXMOX_LIVE_CONNECTION_LOST).toBe('Lost the live connection. Reconnecting…');
  });

  it('fills in the address, port and time of w3, and leaves the time out when nothing ever arrived', () => {
    expect(unreachableMessage(connection({ host: '10.0.0.5', port: 8443 }), true, true)).toBe(
      "Can't reach Proxmox at 10.0.0.5:8443. Showing the last data, from 10:42 AM.",
    );
    expect(unreachableMessage(connection({ lastSuccessAt: null }), true, true)).toBe("Can't reach Proxmox at pve.lan:8006.");
  });

  it('formats the clock in 12 or 24 hours', () => {
    expect(formatClockTime(new Date(2026, 0, 1, 0, 5).getTime(), true)).toBe('12:05 AM');
    expect(formatClockTime(new Date(2026, 0, 1, 13, 7).getTime(), true)).toBe('1:07 PM');
    expect(formatClockTime(new Date(2026, 0, 1, 9, 7).getTime(), false)).toBe('09:07');
  });
});

describe('proxmoxStateNotices', () => {
  it('shows nothing before the worker state arrives', () => {
    expect(proxmoxStateNotices(null, true, false)).toEqual([]);
  });

  it('reads no connection at all as not set up', () => {
    expect(proxmoxStateNotices({ connections: [] }, true, false)).toEqual([{ key: 'not-set-up', text: PROXMOX_NOT_SET_UP }]);
  });

  it.each([
    ['collecting', []],
    ['collector_off', [PROXMOX_COLLECTOR_OFF]],
    ['unreachable', ["Can't reach Proxmox at pve.lan:8006. Showing the last data, from 10:42 AM."]],
    ['token_rejected', [PROXMOX_TOKEN_REJECTED]],
    ['certificate_refused', [PROXMOX_CERTIFICATE_REFUSED]],
  ] as const)('maps %s to its message', (state, texts) => {
    expect(proxmoxStateNotices({ connections: [connection({ state })] }, true, true).map((n) => n.text)).toEqual([...texts]);
  });

  it('gives each connection its own notice, keyed by the connection', () => {
    const notices = proxmoxStateNotices({
      connections: [
        connection({ connectionId: 'a', host: 'a.lan', state: 'unreachable', lastSuccessAt: null }),
        connection({ connectionId: 'b', host: 'b.lan', state: 'token_rejected' }),
      ],
    }, true, true);
    expect(notices).toEqual([
      { key: 'a', text: "Can't reach Proxmox at a.lan:8006." },
      { key: 'b', text: PROXMOX_TOKEN_REJECTED },
    ]);
  });

  it('says only where Proxmox is when no data is on screen, even with a last success recorded', () => {
    const texts = proxmoxStateNotices({ connections: [connection({ state: 'unreachable' })] }, true, false).map((n) => n.text);
    expect(texts).toEqual(["Can't reach Proxmox at pve.lan:8006."]);
  });
});

describe('proxmoxDataExpected', () => {
  it('expects data while the state is unknown or a connection is collecting', () => {
    expect(proxmoxDataExpected(null)).toBe(true);
    expect(proxmoxDataExpected({ connections: [connection({})] })).toBe(true);
    expect(proxmoxDataExpected({ connections: [] })).toBe(false);
    expect(proxmoxDataExpected({ connections: [connection({ state: 'collector_off' })] })).toBe(false);
  });
});

describe('ProxmoxNoticeList', () => {
  it('renders one alert per notice and nothing for none', () => {
    const { container, rerender } = render(<ProxmoxNoticeList notices={[]} />);
    expect(container.innerHTML).toBe('');
    rerender(<ProxmoxNoticeList notices={[{ key: 'x', text: PROXMOX_NOT_SET_UP }]} />);
    expect(screen.getByRole('alert').textContent).toBe(PROXMOX_NOT_SET_UP);
  });
});
