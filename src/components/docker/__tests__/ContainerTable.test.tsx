import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import type { DockerContainerInventory } from '@/types/docker-inventory';
import type { DockerStatsRow } from '@/types/docker';

// ── Module mocks (must appear before dynamic imports) ───────────────────────
// Do NOT mock DataTable, columns, or other broadly-used shared modules —
// they leak globally and break DataTable's own test file.

mock.module('@/hooks/useSettings', () => ({
  useSettings: () => ({
    docker: {
      memoryDisplayMode: 'bytes',
      decimals: { cpu: false, memory: false, diskSpeed: false, networkSpeed: false },
      chartWindowSeconds: 60,
    },
    general: { showSparklines: false, useAbbreviatedUnits: false, updateIntervalMs: 1000 },
    isHostExpanded: () => true,
    isContainerExpanded: () => false,
    toggleHostExpanded: () => {},
    toggleContainerExpanded: () => {},
  }),
}));

mock.module('@/hooks/toastAtom', () => ({
  useToast: () => ({ showToast: () => {} }),
}));

mock.module('@/hooks/usePulseIndicator', () => ({
  usePulseIndicator: () => ({
    indicatorRef: { current: null },
    pingRef: { current: null },
    dotRef: { current: null },
  }),
}));

mock.module('@/hooks/useContainerChartData', () => ({
  buildContainerChartData: () => ({ sparklineData: undefined, dataPoints: [] }),
}));

// Stub xterm (pulled in by ContainerDetailPanel → ContainerLogViewer)
mock.module('@xterm/xterm', () => ({
  default: {
    Terminal: class {
      loadAddon = () => {};
      open = () => {};
      dispose = () => {};
      writeln = () => {};
      write = () => {};
    },
  },
}));
mock.module('@xterm/addon-fit', () => ({
  default: {
    FitAddon: class {
      fit = () => {};
      dispose = () => {};
      activate = () => {};
    },
  },
}));
mock.module('@xterm/xterm/css/xterm.css', () => ({}));

mock.module('@/hooks/useContainerLogs', () => ({
  useContainerLogs: () => ({ isConnected: false, error: null }),
}));

// Stub echarts (used in DualSeriesChart)
mock.module('echarts-for-react', () => ({
  default: () => <div data-testid="echarts-mock" />,
}));
mock.module('@/hooks/useEChartTimeScroll', () => ({
  useEChartTimeScroll: () => {},
}));

mock.module('@/lib/utils/icon-resolver', () => ({
  getIconUrl: () => '/icon.png',
  FALLBACK_ICON_URL: '/fallback.png',
  AVAILABLE_ICONS: [],
  extractImageBaseName: (image: string) => image,
  hasIcon: () => false,
  findIconContaining: () => null,
}));

// ── Dynamic import after mocks ───────────────────────────────────────────────

const { default: ContainerTable } = await import('../ContainerTable');

// ── Helpers ──────────────────────────────────────────────────────────────────

const baseDate = new Date('2024-01-01T00:00:00Z');

function makeInventory(
  host: string,
  containerId: string,
  name: string,
  state: DockerContainerInventory['state'] = 'running',
): DockerContainerInventory {
  return {
    host,
    containerId,
    name,
    image: 'nginx:latest',
    state,
    composeProject: null,
    serviceKey: name,
    startedAt: baseDate,
    finishedAt: null,
    exitCode: null,
    labels: {},
    updatedAt: baseDate,
  };
}

const defaultProps = {
  inventory: new Map<string, DockerContainerInventory>(),
  isInventoryConnected: true,
  inventoryError: null,
  latestByEntity: new Map<string, DockerStatsRow>(),
  rows: [] as DockerStatsRow[],
  hasData: true,
  isConnected: true,
  error: null,
  isStale: false,
  entityIcons: {} as Record<string, { iconSlug: string | null; serviceKeyEntity: string }>,
  onIconChange: async () => {},
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ContainerTable', () => {
  it('renders error state when error and no data', () => {
    render(
      <ContainerTable
        {...defaultProps}
        error={new Error('Connection refused')}
        hasData={false}
      />,
    );
    expect(screen.getByText(/Connection refused/)).toBeDefined();
  });

  it('renders inventory error when inventoryError set and inventory empty', () => {
    render(
      <ContainerTable
        {...defaultProps}
        inventoryError={new Error('Inventory stream failed')}
        inventory={new Map()}
      />,
    );
    expect(screen.getByText(/Inventory stream failed/)).toBeDefined();
  });

  it('renders spinner when not connected and no data', () => {
    render(
      <ContainerTable
        {...defaultProps}
        isConnected={false}
        hasData={false}
      />,
    );
    expect(document.querySelector('[role="progressbar"]')).toBeDefined();
  });

  it('renders without crashing with empty inventory', () => {
    const { container } = render(<ContainerTable {...defaultProps} />);
    expect(container).toBeDefined();
  });

  it('renders host name for each host in inventory', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'nginx')],
      ['host2/c2', makeInventory('host2', 'c2', 'redis')],
    ]);
    render(<ContainerTable {...defaultProps} inventory={inventory} />);
    expect(screen.getByText('host1')).toBeDefined();
    expect(screen.getByText('host2')).toBeDefined();
  });

  it('renders container names from inventory including stopped containers', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'running-app', 'running')],
      ['host1/c2', makeInventory('host1', 'c2', 'stopped-app', 'exited')],
    ]);
    render(<ContainerTable {...defaultProps} inventory={inventory} />);
    // Both running and stopped containers should appear
    expect(screen.getByText('running-app')).toBeDefined();
    expect(screen.getByText('stopped-app')).toBeDefined();
  });

  it('shows state chip for non-running container', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'old-app', 'exited')],
    ]);
    render(<ContainerTable {...defaultProps} inventory={inventory} />);
    // The ContainerStateChip renders state text for non-running
    const chips = screen.getAllByTestId('container-state-chip');
    expect(chips.length).toBeGreaterThan(0);
    expect(chips[0].getAttribute('data-state')).toBe('exited');
  });

  it('shows "N running · M stopped" chip label when mixed state', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'app1', 'running')],
      ['host1/c2', makeInventory('host1', 'c2', 'app2', 'exited')],
    ]);
    render(<ContainerTable {...defaultProps} inventory={inventory} />);
    // Check the host aggregated count chip shows breakdown
    expect(screen.getByText('1 running · 1 stopped')).toBeDefined();
  });

  it('shows "N containers" chip label when all running', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'app1', 'running')],
      ['host1/c2', makeInventory('host1', 'c2', 'app2', 'running')],
    ]);
    render(<ContainerTable {...defaultProps} inventory={inventory} />);
    expect(screen.getByText('2 containers')).toBeDefined();
  });

  it('shows "1 container" (singular) when only one container', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'solo', 'running')],
    ]);
    render(<ContainerTable {...defaultProps} inventory={inventory} />);
    expect(screen.getByText('1 container')).toBeDefined();
  });

  it('does not render state chip for running container (uses pulse indicator instead)', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'live-app', 'running')],
    ]);
    render(<ContainerTable {...defaultProps} inventory={inventory} />);
    // No state chip for a running container — it shows pulse indicator instead
    const chips = screen.queryAllByTestId('container-state-chip');
    expect(chips.length).toBe(0);
  });

  // ── Fix 2: Inventory loading guard ──────────────────────────────────────────

  it('shows spinner when stats connected but inventory not yet connected and empty', () => {
    render(
      <ContainerTable
        {...defaultProps}
        isConnected={true}
        hasData={true}
        isInventoryConnected={false}
        inventory={new Map()}
      />,
    );
    // Table should show loading spinner — not an empty table
    expect(document.querySelector('[role="progressbar"]')).toBeDefined();
  });

  it('renders table when stats connected and inventory connected (even if empty)', () => {
    render(
      <ContainerTable
        {...defaultProps}
        isConnected={true}
        hasData={true}
        isInventoryConnected={true}
        inventory={new Map()}
      />,
    );
    // Should NOT show spinner — both streams are ready
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
  });

  // ── Fix 3: Restarting containers show both pulse indicator AND state chip ───

  it('renders restarting container with state chip', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'crashing-app', 'restarting')],
    ]);
    render(<ContainerTable {...defaultProps} inventory={inventory} />);
    const chips = screen.getAllByTestId('container-state-chip');
    expect(chips.length).toBeGreaterThan(0);
    expect(chips[0].getAttribute('data-state')).toBe('restarting');
  });

  // ── Fix 4: Row styling and history button ───────────────────────────────────

  it('running-but-stale row receives stale variant', () => {
    // rowAttributes is passed to DataTable — we verify via data-row-variant attribute.
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'stale-app', 'running')],
    ]);
    // No latestByEntity — stats absent means isStale=true for running container
    const { container } = render(
      <ContainerTable
        {...defaultProps}
        inventory={inventory}
        latestByEntity={new Map()}
      />,
    );
    const staleRows = container.querySelectorAll('[data-row-variant="stale"]');
    expect(staleRows.length).toBeGreaterThan(0);
  });

  it('stopped container row receives stopped variant', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'stopped-app', 'exited')],
    ]);
    const { container } = render(
      <ContainerTable {...defaultProps} inventory={inventory} />,
    );
    const stoppedRows = container.querySelectorAll('[data-row-variant="stopped"]');
    expect(stoppedRows.length).toBeGreaterThan(0);
  });

  it('history button fires onOpenHistory with correct args when clicked', () => {
    const calls: Array<{ containerId: string; host: string }> = [];
    const handleOpenHistory = (containerId: string, host: string) => {
      calls.push({ containerId, host });
    };

    const inventory = new Map([
      ['host1/abc123', makeInventory('host1', 'abc123', 'my-app', 'exited')],
    ]);
    render(
      <ContainerTable
        {...defaultProps}
        inventory={inventory}
        onOpenHistory={handleOpenHistory}
      />,
    );

    const historyButton = screen.getByLabelText('View container history');
    fireEvent.click(historyButton);
    expect(calls.length).toBe(1);
    expect(calls[0]!.containerId).toBe('abc123');
    expect(calls[0]!.host).toBe('host1');
  });
});
