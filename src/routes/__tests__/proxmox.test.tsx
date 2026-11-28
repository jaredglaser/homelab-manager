import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@/lib/test/testing-library';
import { QueryClientProvider } from '@tanstack/react-query';
import { Provider, createStore } from 'jotai';
import { mockModule } from '@/lib/test/mock-module';
import { FakeMuxConnection } from '@/lib/test/fake-mux';
import { seedSession } from '@/lib/test/session';
import { queryClient } from '@/lib/query-client';
import type { ProxmoxCollectorStateView, ProxmoxStatsRow } from '@/types/proxmox';
import type * as ProxmoxFunctions from '@/data/proxmox/functions';

const fakeMux = new FakeMuxConnection();
mockModule<typeof import('@/lib/mux/mux-connection')>('@/lib/mux/mux-connection', (real) => ({
  ...real,
  muxConnection: fakeMux,
}));

let historyRows: ProxmoxStatsRow[] = [];
let preloadGate: Promise<void> | null = null;
const webSideTest = mock(async () => ({ ok: true as const, clusterName: 'homelab', release: '9.0', nodeCount: 2 }));
mockModule<typeof ProxmoxFunctions>('@/data/proxmox/functions', (real) => ({
  ...real,
  testProxmoxConnection: webSideTest as unknown as typeof real.testProxmoxConnection,
  getHistoricalProxmoxStats: (async () => {
    await preloadGate;
    return historyRows;
  }) as unknown as typeof real.getHistoricalProxmoxStats,
}));

const { Route } = await import('@/routes/proxmox');
const { unreachableMessage } = await import('@/components/proxmox/ProxmoxNotices');
const ProxmoxPage = Route.options.component!;

const W1 = "Proxmox isn't set up. Add your cluster in Settings, under Proxmox.";
const W4 = 'Proxmox rejected the API token. Check the token ID and secret, and that the token can read the cluster.';
const W5 = "Proxmox's certificate isn't trusted. Allow self-signed certificates for this connection, or give Proxmox a trusted certificate.";
const W6 = 'Lost the live connection. Reconnecting…';

function row(host: string, overrides: Partial<ProxmoxStatsRow>): ProxmoxStatsRow {
  return {
    time: Date.now() - 2_000,
    host,
    entity_type: 'node',
    node: 'pve1',
    entity_id: 'pve1',
    entity_name: 'pve1',
    status: 'online',
    cpu: 1,
    max_cpu: 4,
    mem: 1e9,
    max_mem: 4e9,
    disk: 1e9,
    max_disk: 10e9,
    uptime: 3600,
    vmid: null,
    net_in_bytes_per_sec: null,
    net_out_bytes_per_sec: null,
    disk_read_bytes_per_sec: null,
    disk_write_bytes_per_sec: null,
    storage_type: null,
    storage_content: null,
    storage_avail: null,
    storage_shared: null,
    cluster_version: null,
    ...overrides,
  };
}

function clusterRows(host: string, clusterName: string, guestName: string, rates: Partial<ProxmoxStatsRow> = {}): ProxmoxStatsRow[] {
  return [
    row(host, { entity_type: 'cluster', node: null, entity_id: clusterName, entity_name: clusterName, status: 'quorate', cluster_version: 3 }),
    row(host, {}),
    row(host, {
      entity_type: 'qemu', entity_id: '100', entity_name: guestName, status: 'running', vmid: 100,
      cpu: 0.25, max_cpu: 2, net_in_bytes_per_sec: 125_000, net_out_bytes_per_sec: 250_000,
      disk_read_bytes_per_sec: 2048, disk_write_bytes_per_sec: 1024, ...rates,
    }),
    row(host, {
      entity_type: 'lxc', entity_id: '200', entity_name: `${guestName}-ct`, status: 'running', vmid: 200,
      cpu: 0.1, max_cpu: 1, net_in_bytes_per_sec: 10, net_out_bytes_per_sec: 20,
      disk_read_bytes_per_sec: 30, disk_write_bytes_per_sec: 40,
    }),
    row(host, {
      entity_type: 'storage', entity_id: 'pve1/local', entity_name: 'local', status: 'active',
      cpu: null, max_cpu: null, mem: null, max_mem: null, disk: 20e9, max_disk: 100e9, uptime: null,
      storage_type: 'dir', storage_content: 'images,iso', storage_avail: 80e9, storage_shared: false,
    }),
  ];
}

function connection(overrides: Partial<ProxmoxCollectorStateView>): ProxmoxCollectorStateView {
  return {
    connectionId: '1',
    host: 'pve.lan',
    port: 8006,
    state: 'collecting',
    lastSuccessAt: new Date(2026, 10, 27, 10, 42).getTime(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function sendState(connections: ProxmoxCollectorStateView[]) {
  act(() => fakeMux.emitWire('proxmox-state', 'data', { connections }));
}

function renderPage() {
  render(
    <QueryClientProvider client={queryClient}>
      <Provider store={createStore()}><ProxmoxPage /></Provider>
    </QueryClientProvider>,
  );
}

let errorSpy: ReturnType<typeof spyOn<Console, 'error'>>;

beforeEach(() => {
  fakeMux.subscriptions.clear();
  fakeMux.status = { connected: true, error: null };
  queryClient.clear();
  seedSession('viewer');
  historyRows = clusterRows('pve.lan', 'homelab', 'web-vm');
  preloadGate = null;
  errorSpy = spyOn(console, 'error').mockImplementation(mock(() => {}));
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('Proxmox page, worker state', () => {
  it('shows w3 with the address and the last data time during an outage over the last data, and clears it on the next success with no reload', async () => {
    renderPage();
    await screen.findByText('web-vm');

    sendState([connection({ state: 'unreachable' })]);
    expect(await screen.findByText("Can't reach Proxmox at pve.lan:8006. Showing the last data, from 10:42 AM.")).toBeTruthy();
    expect(screen.getByText('web-vm')).toBeTruthy();
    expect(screen.getByText('homelab')).toBeTruthy();

    sendState([connection({ state: 'collecting' })]);
    await waitFor(() => expect(screen.queryByText(/Can't reach Proxmox/) === null).toBe(true));
    expect(screen.getByText('web-vm')).toBeTruthy();
    expect(fakeMux.subscriptionCount('proxmox-state')).toBe(1);
  });

  it('shows w3 only once the preload has settled, in its long form when the preload brought data', async () => {
    let open!: () => void;
    preloadGate = new Promise((resolve) => { open = resolve; });
    renderPage();
    sendState([connection({ state: 'unreachable' })]);
    expect(await screen.findByText('Loading Proxmox cluster data...')).toBeTruthy();
    expect(screen.queryByText(/Can't reach Proxmox/) === null).toBe(true);

    open();
    expect(await screen.findByText("Can't reach Proxmox at pve.lan:8006. Showing the last data, from 10:42 AM.")).toBeTruthy();
  });

  it('leaves the time out of w3 when no data is on screen, though Proxmox answered before', async () => {
    historyRows = [];
    renderPage();
    sendState([connection({ state: 'unreachable' })]);
    expect(await screen.findByText("Can't reach Proxmox at pve.lan:8006.")).toBeTruthy();
    expect(screen.queryByText(/Showing the last data/) === null).toBe(true);
  });

  it('writes the time in 24-hour form when the user has turned 12-hour time off', () => {
    expect(unreachableMessage(connection({}), false, true)).toBe("Can't reach Proxmox at pve.lan:8006. Showing the last data, from 10:42.");
  });

  it('shows w3 without a time when Proxmox never answered', async () => {
    historyRows = [];
    renderPage();
    sendState([connection({ state: 'unreachable', lastSuccessAt: null })]);
    expect(await screen.findByText("Can't reach Proxmox at pve.lan:8006.")).toBeTruthy();
    expect(screen.queryByText('Loading Proxmox cluster data...')).toBeNull();
  });

  it.each([
    ['no connection is set up', [] as ProxmoxCollectorStateView[], W1],
    ['the token is rejected', [connection({ state: 'token_rejected' })], W4],
    ['the certificate is refused', [connection({ state: 'certificate_refused' })], W5],
  ])('shows the accepted message when %s', async (_, connections, message) => {
    historyRows = [];
    renderPage();
    sendState(connections);
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByText('Loading Proxmox cluster data...')).toBeNull();
  });

  it('shows the loading spinner, not a notice, until the worker state arrives', async () => {
    historyRows = [];
    renderPage();
    expect(await screen.findByText('Loading Proxmox cluster data...')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows w6 when the live stream fails, with the detail in the console only', async () => {
    renderPage();
    await screen.findByText('web-vm');

    act(() => fakeMux.emit('stats:proxmox', 'error', { message: 'Stats polling failed, retrying', gone: false }));
    expect(await screen.findByText(W6)).toBeTruthy();
    expect(screen.queryByText(/stream unavailable/)).toBeNull();
    expect(errorSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes('[proxmox] Live stream error'))).toBe(true);
    expect(screen.getByText('web-vm')).toBeTruthy();
  });

  it('shows the worker state and never runs the web-side connection test', async () => {
    renderPage();
    sendState([connection({ state: 'unreachable', lastSuccessAt: null })]);

    expect(await screen.findByText(unreachableMessage(connection({}), false, false))).toBeTruthy();
    expect(webSideTest).not.toHaveBeenCalled();
  });
});

describe('Proxmox page, guest table', () => {
  it('heads the rate columns Net in, Net out, Disk read and Disk write and shows the rates', async () => {
    renderPage();
    await screen.findByText('web-vm');

    for (const header of ['Net in', 'Net out', 'Disk read', 'Disk write']) {
      expect(screen.getAllByText(header).length).toBeGreaterThan(0);
    }
    const guestRow = screen.getByText('web-vm').closest('.group.grid') as HTMLElement;
    expect(within(guestRow).getAllByText('Mbps')).toHaveLength(2);
    expect(within(guestRow).getAllByText('KiB/s')).toHaveLength(2);
    expect(within(guestRow).getAllByText('1.00')).toHaveLength(2);
    expect(within(guestRow).getAllByText('2.00')).toHaveLength(2);
  });

  it('shows the empty dash, never 0, for a rate the worker has not got yet', async () => {
    historyRows = clusterRows('pve.lan', 'homelab', 'web-vm', {
      net_in_bytes_per_sec: null, net_out_bytes_per_sec: null, disk_read_bytes_per_sec: null, disk_write_bytes_per_sec: null,
    });
    renderPage();
    await screen.findByText('web-vm');

    const guestRow = screen.getByText('web-vm').closest('.group.grid') as HTMLElement;
    expect(within(guestRow).getAllByText('—')).toHaveLength(4);
    expect(within(guestRow).queryByText('0')).toBeNull();
  });

  it('shows the empty dash for a stopped guest, as for its CPU', async () => {
    historyRows = clusterRows('pve.lan', 'homelab', 'web-vm', { status: 'stopped' });
    renderPage();
    await screen.findByText('web-vm');

    const guestRow = screen.getByText('web-vm').closest('.group.grid') as HTMLElement;
    expect(within(guestRow).getAllByText('—')).toHaveLength(5);
  });

  it('shows a guest 100 from each of two clusters as separate rows under separate hosts', async () => {
    historyRows = [...clusterRows('pve-a.lan', 'alpha', 'alpha-vm'), ...clusterRows('pve-b.lan', 'beta', 'beta-vm')];
    renderPage();

    expect(await screen.findByText('alpha-vm')).toBeTruthy();
    expect(screen.getByText('beta-vm')).toBeTruthy();
    const panels = ['pve-a.lan/pve1', 'pve-b.lan/pve1'].map((key) => document.getElementById(`proxmox-host-panel-${key}`));
    expect(panels.every((panel) => panel !== null)).toBe(true);
    expect(within(panels[0]!).queryByText('beta-vm')).toBeNull();
    expect(within(panels[1]!).queryByText('alpha-vm')).toBeNull();
  });

  it('lists the containers and storage of a node, and collapses the node by click or keyboard', async () => {
    renderPage();
    expect(await screen.findByText('web-vm-ct')).toBeTruthy();
    expect(screen.getByText('Storage (1)')).toBeTruthy();
    expect(screen.getByText('LXC Containers (1)')).toBeTruthy();

    const host = screen.getByRole('button', { name: /pve1/, expanded: true });
    fireEvent.click(host);
    await waitFor(() => expect(host.getAttribute('aria-expanded')).toBe('false'));
    fireEvent.keyDown(host, { key: 'Enter' });
    await waitFor(() => expect(host.getAttribute('aria-expanded')).toBe('true'));

    for (const label of ['Virtual Machines (1)', 'LXC Containers (1)', 'Storage (1)']) {
      const section = screen.getByRole('button', { name: label });
      fireEvent.click(section);
      await waitFor(() => expect(section.getAttribute('aria-expanded')).toBe('false'));
    }
  });
});
