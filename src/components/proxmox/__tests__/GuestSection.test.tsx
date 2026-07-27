import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { GuestSection } from '@/components/proxmox/GuestSection';
import type { GuestRow } from '@/types/proxmox';

function makeGuest(overrides: Partial<GuestRow> = {}): GuestRow {
  return {
    vmid: 100,
    name: 'ubuntu-server',
    status: 'running',
    cpu: 0.2,
    cpus: 2,
    mem: 1_000_000_000,
    maxmem: 4_000_000_000,
    netin: 1000,
    netout: 500,
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

describe('GuestSection', () => {
  it('renders the section label with a guest count and expands to show a guest name', () => {
    render(
      <GuestSection
        label="Virtual Machines"
        guests={[makeGuest()]}
        expanded
        onToggle={() => {}}
        showSparklines={false}
        useAbbreviatedUnits={false}
      />,
    );

    expect(screen.getByText('Virtual Machines (1)')).not.toBeNull();
    expect(screen.getByText('ubuntu-server')).not.toBeNull();
  });

  it('gives the status column a tighter mobile track than the metric columns', () => {
    const restore = mockNarrowResizeObserver(800);
    try {
      render(
        <GuestSection
          label="Virtual Machines"
          guests={[makeGuest()]}
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
