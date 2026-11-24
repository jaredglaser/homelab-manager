import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { findOpenTooltip, seedSession } from '@/lib/test/session';
import { setupUser } from '@/lib/test/user-event';
import { render, screen, fireEvent } from '@testing-library/react';
import { VIEWER_DENIED_COPY } from '@/hooks/useAuth';
import type { ComponentProps } from 'react';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';
import { mockModule } from '@/lib/test/mock-module';

mockModule<typeof import('@/hooks/useEChartTimeScroll')>('@/hooks/useEChartTimeScroll', (real) => ({ ...real, 
  useEChartTimeScroll: () => {},
}));

mock.module('@/components/docker/DualSeriesChartRenderer', () => ({
  default: ({ option }: { option: unknown }) => (
    <div data-testid="echarts-mock" data-option={JSON.stringify(option)} />
  ),
}));

mock.module('@/components/docker/ContainerLogViewer', () => ({
  default: () => <div data-testid="log-viewer" />,
}));

mock.module('@/components/docker/ContainerModal', () => ({
  default: () => null,
}));

mock.module('@/components/docker/ContainerActionButtons', () => ({
  default: () => null,
}));

const { default: ContainerDetailPanel } = await import('@/components/docker/ContainerDetailPanel');
const { createStore, Provider } = await import('jotai');

const sampleDataPoints = [
  {
    timestamp: 1000,
    cpuPercent: 25,
    memoryPercent: 50,
    blockIoReadBytesPerSec: 100,
    blockIoWriteBytesPerSec: 200,
    networkRxBytesPerSec: 300,
    networkTxBytesPerSec: 400,
  },
  {
    timestamp: 2000,
    cpuPercent: 30,
    memoryPercent: 55,
    blockIoReadBytesPerSec: 150,
    blockIoWriteBytesPerSec: 250,
    networkRxBytesPerSec: 350,
    networkTxBytesPerSec: 450,
  },
];

const sampleInventory: DockerInventorySnapshotContainer = {
  host: 'server',
  containerId: 'abc123',
  name: 'nginx-proxy',
  image: 'nginx:latest',
  imageDigest: null,
  state: 'running',
  composeProject: null,
  serviceKey: 'nginx-proxy',
  startedAt: new Date('2024-01-01T00:00:00Z'),
  finishedAt: null,
  exitCode: null,
  labels: {},
  ports: [],
  mounts: [],
  updatedAt: new Date('2024-01-01T00:00:00Z'),
};

function renderPanel(overrides: Partial<ComponentProps<typeof ContainerDetailPanel>> = {}) {
  const store = createStore();
  return render(
    <Provider store={store}>
      <ContainerDetailPanel
        dataPoints={sampleDataPoints}
        containerId="abc123"
        host="server"
        inventory={sampleInventory}
        serviceKeyEntity="server/abc123"
        onIconChange={async () => {}}
        {...overrides}
      />
    </Provider>,
  );
}

beforeEach(() => {
  seedSession('admin');
});

describe('ContainerDetailPanel', () => {
  it('disables the Icon control for a viewer with the role reason, and a click opens no picker', async () => {
    seedSession('viewer');
    renderPanel();
    const user = setupUser();
    const icon = screen.getByRole('button', { name: 'Icon' });
    expect(icon.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(icon);
    await user.hover(icon);
    expect(await findOpenTooltip()).toBe(VIEWER_DENIED_COPY);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each(['admin', 'operator'] as const)('opens the icon picker for an %s', async (role) => {
    seedSession(role);
    renderPanel();
    const icon = screen.getByRole('button', { name: 'Icon' });
    expect(icon.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(icon);
    expect(await screen.findByRole('dialog')).toBeDefined();
  });

  it('renders a combined metrics chart', () => {
    renderPanel();
    // New design uses a single combined chart with 6 stackable series
    expect(screen.getAllByTestId('echarts-mock')).toHaveLength(1);
  });

  it('renders the log preview panel', () => {
    renderPanel();
    screen.getByTestId('log-viewer');
  });

  it('renders metric legend chips for CPU and Memory by default', () => {
    renderPanel();
    screen.getByText('CPU');
    screen.getByText('Memory');
    screen.getByText('Block Read');
    screen.getByText('Block Write');
    screen.getByText('Net RX');
    screen.getByText('Net TX');
  });

  it('renders with empty data points', () => {
    renderPanel({ dataPoints: [] });
    expect(screen.getAllByTestId('echarts-mock')).toHaveLength(1);
    screen.getByTestId('log-viewer');
  });

  it('shows the status strip with container state', () => {
    renderPanel();
    // State chip shows "running"
    screen.getByText('running');
  });

  it('shows exit metadata for an exited container', () => {
    renderPanel({
      inventory: {
        ...sampleInventory,
        state: 'exited',
        finishedAt: new Date('2024-01-01T01:00:00Z'),
        exitCode: 137,
      },
    });

    screen.getByText('exited');
    screen.getByText('137');
    screen.getByText('Finished');
    screen.getByText('Exit');
  });

  it('does not render the ports/mounts strip when both are empty', () => {
    renderPanel();
    expect(screen.queryByText('->')).toBeNull();
  });

  it('renders port and mount details between the status strip and the charts', () => {
    renderPanel({
      inventory: {
        ...sampleInventory,
        ports: [{ containerPort: 80, protocol: 'tcp', hostIp: null, hostPort: 8080 }],
        mounts: [{ type: 'bind', source: '/srv/data', destination: '/data', rw: true }],
      },
    });

    screen.getByText('8080->80/tcp');
    screen.getByText('/srv/data');
    screen.getByText('/data');
  });

});
