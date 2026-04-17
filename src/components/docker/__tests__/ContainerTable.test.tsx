import { describe, it, expect, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
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

mock.module('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));

mock.module('@/data/docker/functions', () => ({
  getDockerEntityIcons: async () => ({}),
  updateContainerIcon: async () => {},
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
  latestByEntity: new Map<string, DockerStatsRow>(),
  rows: [] as DockerStatsRow[],
  hasData: true,
  isConnected: true,
  error: null,
  isStale: false,
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
});
