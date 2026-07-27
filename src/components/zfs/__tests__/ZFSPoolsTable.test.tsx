import { describe, it, expect, mock, afterEach } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import ZFSPoolsTable from '@/components/zfs/ZFSPoolsTable';
import type { ZFSStatsRow } from '@/types/zfs';

// Expanding a vdev persists the change via updateSetting, a createServerFn that
// requires the TanStack Start server runtime. Stub it so the expand click under
// test doesn't hit that unrelated failure path.
mock.module('@/data/settings/functions', () => ({
  updateSetting: mock(() => Promise.resolve()),
}));

/**
 * Regression coverage for the ZFS subtable nesting: PoolSubTable, VdevDiskSubTable,
 * and DiskSubTable (src/components/zfs/subtables/) each render a further-nested
 * DataTable without declaring their own `metricGroups`, relying entirely on the
 * MetricGroupContext the top-level ZFSPoolsTable DataTable provides. This locks in
 * that the inherited mobile column filter reaches all the way down to the disk
 * level, three DataTable layers below the one that owns the metric groups.
 */
function makeRow(overrides: Partial<ZFSStatsRow>): ZFSStatsRow {
  return {
    time: Date.now(),
    host: 'nas01',
    pool: 'tank',
    entity: 'tank',
    entity_type: 'pool',
    indent: 0,
    capacity_alloc: 1000,
    capacity_free: 2000,
    read_ops_per_sec: 10,
    write_ops_per_sec: 5,
    read_bytes_per_sec: 1024,
    write_bytes_per_sec: 512,
    utilization_percent: 25,
    ...overrides,
  };
}

const rows: ZFSStatsRow[] = [
  makeRow({ entity: 'tank', entity_type: 'pool', indent: 0 }),
  makeRow({ entity: 'tank/mirror-0', entity_type: 'vdev', indent: 2 }),
  makeRow({ entity: 'tank/mirror-0/sda', entity_type: 'disk', indent: 4 }),
  makeRow({ entity: 'tank/mirror-0/sdb', entity_type: 'disk', indent: 4 }),
  makeRow({ entity: 'tank/mirror-1', entity_type: 'vdev', indent: 2 }),
  makeRow({ entity: 'tank/mirror-1/sdc', entity_type: 'disk', indent: 4 }),
];

function latestByEntity(): Map<string, ZFSStatsRow> {
  const map = new Map<string, ZFSStatsRow>();
  for (const row of rows) map.set(row.entity, row);
  return map;
}

const originalMatchMedia = window.matchMedia;

function setMobileViewport(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

function restoreMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
}

function mockNarrowResizeObserver() {
  const original = globalThis.ResizeObserver;
  let cb: ResizeObserverCallback | null = null;
  globalThis.ResizeObserver = class MockResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      cb = callback;
    }
    observe() {
      cb?.(
        [{ contentRect: { width: 375 } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  return () => {
    globalThis.ResizeObserver = original;
  };
}

describe('ZFSPoolsTable nested metric group inheritance on mobile', () => {
  it('limits a disk row three DataTable levels deep to the active metric group', () => {
    const restore = mockNarrowResizeObserver();
    try {
      render(
        <Provider store={createStore()}>
          <ZFSPoolsTable
            latestByEntity={latestByEntity()}
            hasData
            isConnected
            error={null}
            isStale={false}
          />
        </Provider>,
      );

      // Host ("nas01") and its single pool ("tank") auto-expand (isZfsHostExpanded /
      // isPoolExpanded both default to expanded when there is only one of them).
      expect(screen.getByText('nas01')).not.toBeNull();
      expect(screen.getByText('tank')).not.toBeNull();
      expect(screen.getByText('mirror-0')).not.toBeNull();

      // Vdevs default to collapsed; expand mirror-0 to mount its DiskSubTable.
      fireEvent.click(screen.getByText('mirror-0').closest('[role="button"]')!);
      expect(screen.getByText('sda')).not.toBeNull();

      // Capacity is the default active metric group -> only "name" + "capacity"
      // should be visible columns on a disk row, out of the 7 the full column set defines.
      const diskRow = screen.getByText('sda').closest('.group') as HTMLElement;
      expect(diskRow.children.length).toBe(2);
    } finally {
      restore();
    }
  });

  it('follows the parent toggle when the active metric group changes, all the way to the disk level', () => {
    const restore = mockNarrowResizeObserver();
    try {
      render(
        <Provider store={createStore()}>
          <ZFSPoolsTable
            latestByEntity={latestByEntity()}
            hasData
            isConnected
            error={null}
            isStale={false}
          />
        </Provider>,
      );

      fireEvent.click(screen.getByText('mirror-0').closest('[role="button"]')!);
      expect(screen.getByText('sda')).not.toBeNull();

      // Switch the parent's active group to "Throughput" (3 columns: readBytes,
      // writeBytes, utilization) via its toolbar toggle.
      fireEvent.click(screen.getByRole('button', { name: 'Throughput' }));

      const diskRow = screen.getByText('sda').closest('.group') as HTMLElement;
      // name + 3 throughput columns
      expect(diskRow.children.length).toBe(4);
    } finally {
      restore();
    }
  });
});

describe('ZFSPoolsTable mobile layout (viewport-width based, not container-width)', () => {
  afterEach(() => {
    restoreMatchMedia();
  });

  it('caps the table height on mobile instead of letting it compete with the speed charts below for flex space', () => {
    setMobileViewport(true);
    render(
      <Provider store={createStore()}>
        <ZFSPoolsTable
          latestByEntity={latestByEntity()}
          hasData
          isConnected
          error={null}
          isStale={false}
        />
      </Provider>,
    );

    const scrollContainer = document.querySelector('[data-slot="datatable-header"]')!
      .parentElement as HTMLElement;
    expect(scrollContainer.style.maxHeight).toBe('480px');
  });

  it('leaves the table filling the viewport on non-mobile widths (unbounded height, flex-1 wrapper)', () => {
    setMobileViewport(false);
    const { container } = render(
      <Provider store={createStore()}>
        <ZFSPoolsTable
          latestByEntity={latestByEntity()}
          hasData
          isConnected
          error={null}
          isStale={false}
        />
      </Provider>,
    );

    const scrollContainer = document.querySelector('[data-slot="datatable-header"]')!
      .parentElement as HTMLElement;
    expect(scrollContainer.style.maxHeight).toBe('');
    expect((container.firstChild as HTMLElement).className).toContain('flex-1');
  });
});
