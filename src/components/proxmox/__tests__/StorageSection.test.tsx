import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { StorageSection } from '@/components/proxmox/StorageSection';
import type { ProxmoxStorage } from '@/types/proxmox';

function makeStorage(overrides: Partial<ProxmoxStorage> = {}): ProxmoxStorage {
  return {
    storage: 'local-zfs',
    type: 'zfspool',
    content: 'images',
    active: 1,
    enabled: 1,
    shared: 0,
    used: 100_000_000_000,
    avail: 400_000_000_000,
    total: 500_000_000_000,
    used_fraction: 0.2,
    ...overrides,
  };
}

function mockNarrowResizeObserver(width: number) {
  const originalResizeObserver = globalThis.ResizeObserver;
  let resizeCallback: ResizeObserverCallback | null = null;

  globalThis.ResizeObserver = class MockResizeObserver {
    constructor(cb: ResizeObserverCallback) {
      resizeCallback = cb;
    }
    observe() {
      if (resizeCallback) {
        resizeCallback(
          [{ contentRect: { width } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;

  return () => {
    globalThis.ResizeObserver = originalResizeObserver;
  };
}

describe('StorageSection', () => {
  it('renders the storage count and a storage name when expanded', () => {
    render(
      <StorageSection
        storages={[makeStorage()]}
        expanded
        onToggle={() => {}}
        showSparklines={false}
        useAbbreviatedUnits={false}
      />,
    );

    expect(screen.getByText('Storage (1)')).not.toBeNull();
    expect(screen.getByText('local-zfs')).not.toBeNull();
  });

  it('gives the status column a tighter mobile track than the metric columns', () => {
    const restore = mockNarrowResizeObserver(800);
    try {
      render(
        <StorageSection
          storages={[makeStorage()]}
          expanded
          onToggle={() => {}}
          showSparklines={false}
          useAbbreviatedUnits={false}
        />,
      );

      const header = document.querySelector('[data-slot="datatable-header"]') as HTMLElement;
      expect(header.style.gridTemplateColumns).toContain('0.7fr');
    } finally {
      restore();
    }
  });
});
