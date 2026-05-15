import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';

mock.module('@/hooks/useEChartTimeScroll', () => ({
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
  state: 'running',
  composeProject: null,
  serviceKey: 'nginx-proxy',
  startedAt: new Date('2024-01-01T00:00:00Z'),
  finishedAt: null,
  exitCode: null,
  labels: {},
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
        {...overrides}
      />
    </Provider>,
  );
}

describe('ContainerDetailPanel', () => {
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

    // State chip shows the state label
    screen.getByText('exited');
    // Exit code shown in status strip
    screen.getByText('137');
    // Finished label and date
    screen.getByText('Finished');
    // Exit label
    screen.getByText('Exit');
  });

  it('shows uptime for a running container with startedAt', () => {
    const recentStart = new Date(Date.now() - 2 * 60 * 1000); // 2 minutes ago
    renderPanel({
      inventory: { ...sampleInventory, startedAt: recentStart },
    });
    screen.getByText('Started');
    screen.getByText('Uptime');
    // Should show something like "2m"
    expect(screen.getByText(/\dm/).textContent).toBeTruthy();
  });

  it('shows uptime with hours when container ran for hours', () => {
    const hourStart = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
    renderPanel({
      inventory: { ...sampleInventory, startedAt: hourStart },
    });
    expect(screen.getByText(/2h/).textContent).toBeTruthy();
  });

  it('clicking Logs button triggers modal open callback', () => {
    renderPanel();
    // The "Open full view" link triggers openModal('logs')
    fireEvent.click(screen.getByText(/Open full view/));
    // ContainerModal is mocked to null, just verify no crash
  });

  it('clicking action strip Logs button triggers action', () => {
    renderPanel();
    const logsBtn = screen.getByText('Logs').closest('button');
    expect(logsBtn).not.toBeNull();
    fireEvent.click(logsBtn!);
  });

  it('clicking action strip History button triggers action', () => {
    renderPanel();
    const historyBtn = screen.getByText('History').closest('button');
    expect(historyBtn).not.toBeNull();
    fireEvent.click(historyBtn!);
  });

  it('clicking action strip Terminal button triggers action for running container', () => {
    renderPanel();
    const terminalBtn = screen.getByText('Terminal').closest('button');
    expect(terminalBtn).not.toBeNull();
    fireEvent.click(terminalBtn!);
  });
});
