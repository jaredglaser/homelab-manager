import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import '@/lib/test/testing-library';
import { QueryClientProvider } from '@tanstack/react-query';
import { Provider, createStore } from 'jotai';
import { mockModule } from '@/lib/test/mock-module';
import { FakeMuxConnection } from '@/lib/test/fake-mux';
import { seedSession } from '@/lib/test/session';
import { setupUser } from '@/lib/test/user-event';
import { queryClient } from '@/lib/query-client';
import type { ZfsScan } from '@homelab-manager/agent/types/protocol';
import type { ZFSEntityType, ZFSHostHealth, ZFSNodeHealth, ZFSStatsRow } from '@/types/zfs';
import type * as ZfsFunctions from '@/data/zfs/functions';

const fakeMux = new FakeMuxConnection();
mockModule<typeof import('@/lib/mux/mux-connection')>('@/lib/mux/mux-connection', (real) => ({
  ...real,
  muxConnection: fakeMux,
}));

// Happy-DOM has no 2D canvas, and the charts are not what these tests read.
mockModule<typeof import('@/components/ui/datatable/SparklineCanvas')>('@/components/ui/datatable/SparklineCanvas', (real) => ({
  ...real,
  default: (() => null) as unknown as typeof real.default,
}));
// Without the real module, its chart file stays out of the coverage table this test would add it to.
void mock.module('@/components/zfs/ZFSPoolSpeedCharts', () => ({ default: () => null }));

let historyRows: ZFSStatsRow[] = [];
mockModule<typeof ZfsFunctions>('@/data/zfs/functions', (real) => ({
  ...real,
  getHistoricalZFSStats: (async () => historyRows) as unknown as typeof real.getHistoricalZFSStats,
}));

const { Route } = await import('@/routes/zfs');
const ZFSPage = Route.options.component!;

const W2 = 'tank on pve1 is degraded. A device has failed or is missing, so the pool has lost redundancy. Your data is still readable.';
const W3 = 'tank on pve1 is faulted. Data on this pool may be unavailable.';
const W6 = "Can't read pool health from pve1. I/O stats are still live.";
const W7 = 'pve1 is offline. Showing pool health from 10:42 AM.';

function row(host: string, entity: string, entityType: ZFSEntityType, readOps = 1): ZFSStatsRow {
  return {
    time: Date.now() - 2_000,
    host,
    pool: 'tank',
    entity,
    entity_type: entityType,
    indent: (entity.split('/').length - 1) * 2,
    capacity_alloc: entityType === 'disk' ? null : 100,
    capacity_free: entityType === 'disk' ? null : 300,
    read_ops_per_sec: readOps,
    write_ops_per_sec: 2,
    read_bytes_per_sec: 3,
    write_bytes_per_sec: 4,
    utilization_percent: null,
  };
}

function tankRows(host: string, readOps = 1): ZFSStatsRow[] {
  return [
    row(host, 'tank', 'pool', readOps),
    row(host, 'tank/mirror-0', 'vdev', readOps),
    row(host, 'tank/mirror-0/sda', 'disk', readOps),
    row(host, 'tank/mirror-0/sdb', 'disk', readOps),
  ];
}

const NO_ERRORS = { read: 0, write: 0, checksum: 0 };

function node(entity: string, entityType: ZFSNodeHealth['entityType'], state: ZFSNodeHealth['state'], errors = entityType === 'pool' ? null : NO_ERRORS): ZFSNodeHealth {
  return { entity, entityType, state, errors };
}

interface HostHealthOptions {
  pool?: ZFSNodeHealth['state'];
  sda?: ZFSNodeHealth['state'];
  sdaErrors?: ZFSNodeHealth['errors'];
  scan?: ZfsScan | null;
  readable?: boolean;
  connected?: boolean;
}

function hostHealth(host: string, options: HostHealthOptions = {}): ZFSHostHealth {
  return {
    host,
    readable: options.readable ?? true,
    connected: options.connected ?? true,
    lastSeenAt: new Date(2026, 10, 27, 10, 42).getTime(),
    pools: [{
      pool: 'tank',
      scan: options.scan === undefined ? null : options.scan,
      nodes: [
        node('tank', 'pool', options.pool ?? 'online'),
        node('tank/mirror-0', 'vdev', options.pool ?? 'online'),
        node('tank/mirror-0/sda', 'disk', options.sda ?? 'online', options.sdaErrors ?? NO_ERRORS),
        node('tank/mirror-0/sdb', 'disk', 'online'),
      ],
    }],
  };
}

function sendHealth(hosts: ZFSHostHealth[]) {
  act(() => fakeMux.emitWire('zfs-health', 'data', { hosts }));
}

function renderPage() {
  render(
    <QueryClientProvider client={queryClient}>
      <Provider store={createStore()}><ZFSPage /></Provider>
    </QueryClientProvider>,
  );
}

function scan(overrides: Partial<ZfsScan>): ZfsScan {
  return { kind: 'scrub', state: 'running', percentDone: 42, endedAt: null, repairedBytes: 0, errors: 0, ...overrides };
}

let errorSpy: ReturnType<typeof spyOn<Console, 'error'>>;

beforeEach(() => {
  fakeMux.subscriptions.clear();
  fakeMux.status = { connected: true, error: null };
  queryClient.clear();
  seedSession('viewer');
  historyRows = tankRows('pve1');
  errorSpy = spyOn(console, 'error').mockImplementation(mock(() => {}));
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('ZFS page, pool health', () => {
  it('shows the degraded chip and banner as soon as the health changes, without a reload, on the right host only', async () => {
    historyRows = [...tankRows('pve1'), ...tankRows('pve2')];
    const user = setupUser();
    renderPage();
    await user.click(await screen.findByText('pve1'));
    sendHealth([hostHealth('pve1'), hostHealth('pve2')]);
    await waitFor(() => expect(screen.getAllByText('Online').length).toBeGreaterThan(0));
    expect(screen.queryByText('Degraded')).toBeNull();

    sendHealth([hostHealth('pve1', { pool: 'degraded', sda: 'faulted' }), hostHealth('pve2')]);

    expect(await screen.findByText(W2)).toBeTruthy();
    expect(screen.getAllByText('Degraded').length).toBe(1);
    expect(screen.getByText('Faulted')).toBeTruthy();
    expect(screen.queryByText(/on pve2 is/)).toBeNull();
    expect(fakeMux.subscriptionCount('zfs-health')).toBe(1);
  });

  it.each(['faulted', 'suspended', 'unavailable'] as const)('shows the faulted banner for a %s pool', async (state) => {
    renderPage();
    sendHealth([hostHealth('pve1', { pool: state })]);
    expect(await screen.findByText(W3)).toBeTruthy();
  });

  it('shows scrub progress as it moves, then the result when it finishes', async () => {
    renderPage();
    await screen.findAllByText('pve1');
    sendHealth([hostHealth('pve1', { scan: scan({}) })]);
    expect(await screen.findByText('Scrub running, 42% done')).toBeTruthy();

    sendHealth([hostHealth('pve1', { scan: scan({ percentDone: 43 }) })]);
    expect(await screen.findByText('Scrub running, 43% done')).toBeTruthy();

    sendHealth([hostHealth('pve1', { scan: scan({ state: 'finished', percentDone: null, endedAt: new Date(2026, 10, 23, 4).getTime() }) })]);
    expect(await screen.findByText('Last scrub Nov 23, repaired 0 B, 0 errors')).toBeTruthy();
    expect(screen.queryByText(/Scrub running/)).toBeNull();
  });

  it('shows resilver progress, then its result', async () => {
    renderPage();
    sendHealth([hostHealth('pve1', { scan: scan({ kind: 'resilver' }) })]);
    expect(await screen.findByText('Resilvering, 42% done')).toBeTruthy();

    const endedAt = new Date(2026, 10, 23, 4).getTime();
    sendHealth([hostHealth('pve1', { scan: scan({ kind: 'resilver', state: 'finished', percentDone: null, endedAt, repairedBytes: 1.5 * 1024 ** 3 }) })]);
    expect(await screen.findByText('Last resilver Nov 23, repaired 1.5 GiB, 0 errors')).toBeTruthy();
  });

  it('tells which host it cannot read health from while its stats keep coming', async () => {
    renderPage();
    await screen.findAllByText('pve1');
    sendHealth([hostHealth('pve1', { readable: false }), hostHealth('pve2')]);
    expect(await screen.findByText(W6)).toBeTruthy();
    expect(screen.queryByText(/from pve2/)).toBeNull();

    act(() => fakeMux.emitWire('stats:zfs', 'data', tankRows('pve1', 777).map((r) => ({ ...r, time: Date.now() }))));
    expect((await screen.findAllByText('777')).length).toBeGreaterThan(0);
    expect(screen.getByText(W6)).toBeTruthy();
  });

  it('keeps an offline host and its last health on the page once its stats are gone, with when it was last seen', async () => {
    historyRows = tankRows('pve2');
    renderPage();
    await screen.findByText('pve2');
    sendHealth([hostHealth('pve1', { connected: false, pool: 'degraded', sda: 'faulted' }), hostHealth('pve2')]);

    expect(await screen.findByText(W7)).toBeTruthy();
    expect(screen.getByText('pve1')).toBeTruthy();
    expect(screen.getByText(W2)).toBeTruthy();
    expect(screen.getByText('Faulted')).toBeTruthy();
  });

  it('prefers the offline notice over the unreadable one', async () => {
    renderPage();
    sendHealth([hostHealth('pve1', { connected: false, readable: false })]);
    expect(await screen.findByText(W7)).toBeTruthy();
    expect(screen.queryByText(W6)).toBeNull();
  });

  it('puts the error counts on the disk chip, and drops them once the counters are cleared', async () => {
    renderPage();
    sendHealth([hostHealth('pve1', { pool: 'degraded', sda: 'faulted', sdaErrors: { read: 3, write: 0, checksum: 12 } })]);
    const faulted = await screen.findByText('Faulted');
    expect(faulted.closest('[data-slot="tooltip-trigger"]')).not.toBeNull();

    sendHealth([hostHealth('pve1', { pool: 'degraded', sda: 'faulted', sdaErrors: NO_ERRORS })]);
    await waitFor(() => expect(screen.getByText('Faulted').closest('[data-slot="tooltip-trigger"]')).toBeNull());
  });

  it('gives a viewer every message and no control in them', async () => {
    renderPage();
    sendHealth([hostHealth('pve1', { readable: false, pool: 'degraded' })]);
    const banner = (await screen.findByText(W2)).closest('[role="alert"]')!;
    const notice = screen.getByText(W6).closest('[role="alert"]')!;
    for (const alert of [banner, notice]) {
      expect(within(alert as HTMLElement).queryAllByRole('button')).toEqual([]);
      expect(within(alert as HTMLElement).queryAllByRole('link')).toEqual([]);
    }
  });
});
