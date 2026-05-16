import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';
import type { DockerStatsRow } from '@/types/docker';

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

// xterm is pulled in by ContainerDetailPanel → ContainerLogViewer
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

// Stub the chart renderer so echarts never loads
mock.module('@/components/docker/DualSeriesChartRenderer', () => ({
  default: () => <div data-testid="echarts-mock" />,
}));
mock.module('@/hooks/useEChartTimeScroll', () => ({
  useEChartTimeScroll: () => {},
}));

mock.module('@/components/docker/ContainerActionButtons', () => ({
  default: () => null,
}));

mock.module('@/lib/utils/icon-resolver', () => ({
  getIconUrl: () => '/icon.png',
  FALLBACK_ICON_URL: '/fallback.png',
  AVAILABLE_ICONS: [],
  extractImageBaseName: (image: string) => image,
  hasIcon: () => false,
  findIconContaining: () => null,
}));

const { default: ContainerTable } = await import('../ContainerTable');
const { createStore, Provider } = await import('jotai');

type TableProps = React.ComponentProps<typeof ContainerTable>;

function renderTable(overrides: Partial<TableProps> = {}) {
  const store = createStore();
  return render(
    <Provider store={store}>
      <ContainerTable {...defaultProps} {...overrides} />
    </Provider>,
  );
}

const baseDate = new Date('2024-01-01T00:00:00Z');

function makeInventory(
  host: string,
  containerId: string,
  name: string,
  state: DockerInventorySnapshotContainer['state'] = 'running',
): DockerInventorySnapshotContainer {
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
  inventory: new Map<string, DockerInventorySnapshotContainer>(),
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

describe('ContainerTable', () => {
  it('renders error state when error and no data', () => {
    renderTable({ error: new Error('Connection refused'), hasData: false });
    expect(screen.getByText(/Connection refused/)).toBeDefined();
  });

  it('renders inventory error when inventoryError set and inventory empty', () => {
    renderTable({ inventoryError: new Error('Inventory stream failed'), inventory: new Map() });
    expect(screen.getByText(/Inventory stream failed/)).toBeDefined();
  });

  it('renders spinner when not connected and no data', () => {
    renderTable({ isConnected: false, hasData: false });
    expect(document.querySelector('[role="progressbar"]')).toBeDefined();
  });

  it('renders without crashing with empty inventory', () => {
    const { container } = renderTable();
    expect(container).toBeDefined();
  });

  it('renders host name for each host in inventory', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'nginx')],
      ['host2/c2', makeInventory('host2', 'c2', 'redis')],
    ]);
    renderTable({ inventory });
    expect(screen.getByText('host1')).toBeDefined();
    expect(screen.getByText('host2')).toBeDefined();
  });

  it('renders container names from inventory including stopped containers', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'running-app', 'running')],
      ['host1/c2', makeInventory('host1', 'c2', 'stopped-app', 'exited')],
    ]);
    renderTable({ inventory });
    expect(screen.getByText('running-app')).toBeDefined();
    expect(screen.getByText('stopped-app')).toBeDefined();
  });

  it('shows state chip for non-running container', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'old-app', 'exited')],
    ]);
    renderTable({ inventory });
    const chips = screen.getAllByTestId('container-state-chip');
    expect(chips.length).toBeGreaterThan(0);
    expect(chips[0].getAttribute('data-state')).toBe('exited');
  });

  it('does not render state chip for running container (uses pulse indicator instead)', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'live-app', 'running')],
    ]);
    renderTable({ inventory });
    const chips = screen.queryAllByTestId('container-state-chip');
    expect(chips.length).toBe(0);
  });

  it('shows spinner when stats connected but inventory not yet connected and empty', () => {
    renderTable({ isConnected: true, hasData: true, isInventoryConnected: false, inventory: new Map() });
    expect(document.querySelector('[role="progressbar"]')).toBeDefined();
  });

  it('renders table when stats connected and inventory connected (even if empty)', () => {
    renderTable({ isConnected: true, hasData: true, isInventoryConnected: true, inventory: new Map() });
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('renders restarting container with state chip', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'crashing-app', 'restarting')],
    ]);
    renderTable({ inventory });
    const chips = screen.getAllByTestId('container-state-chip');
    expect(chips.length).toBeGreaterThan(0);
    expect(chips[0].getAttribute('data-state')).toBe('restarting');
  });

  it('running-but-stale row receives stale variant', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'stale-app', 'running')],
    ]);
    const { container } = renderTable({ inventory, latestByEntity: new Map() });
    const staleRows = container.querySelectorAll('[data-row-variant="stale"]');
    expect(staleRows.length).toBeGreaterThan(0);
  });

  it('stopped container row receives stopped variant', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'stopped-app', 'exited')],
    ]);
    const { container } = renderTable({ inventory });
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
    renderTable({ inventory, onOpenHistory: handleOpenHistory });

    const historyButton = screen.getByLabelText('View container history');
    fireEvent.click(historyButton);
    expect(calls.length).toBe(1);
    expect(calls[0]!.containerId).toBe('abc123');
    expect(calls[0]!.host).toBe('host1');
  });

  it('shows exit metadata in the expanded detail panel for an exited container', () => {
    const inventory = new Map([
      ['host1/abc123', {
        ...makeInventory('host1', 'abc123', 'old-app', 'exited'),
        finishedAt: new Date('2024-01-01T01:00:00Z'),
        exitCode: 137,
      }],
    ]);

    renderTable({ inventory });

    fireEvent.click(screen.getByText('old-app'));

    expect(screen.getAllByText('exited').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Exit')).toBeDefined();
    expect(screen.getByText('137')).toBeDefined();
  });
});
