import { describe, it, expect, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
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

mock.module('@xterm/xterm', () => ({
  default: {
    Terminal: class MockTerminal {
      loadAddon = mock(() => {});
      open = mock(() => {});
      dispose = mock(() => {});
      writeln = mock(() => {});
    },
  },
}));
mock.module('@xterm/addon-fit', () => ({
  default: {
    FitAddon: class MockFitAddon {
      fit = mock(() => {});
      dispose = mock(() => {});
    },
  },
}));
mock.module('@xterm/xterm/css/xterm.css', () => ({}));

mock.module('@/hooks/useContainerLogs', () => ({
  useContainerLogs: () => ({ isConnected: true, error: null }),
}));

const { default: ContainerDetailPanel } = await import('../ContainerDetailPanel');
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
  it('renders two chart sections', () => {
    renderPanel();
    screen.getByText('CPU & Memory');
    screen.getByText('Network I/O');
  });

  it('renders the log viewer', () => {
    renderPanel();
    screen.getByText('Logs');
  });

  it('renders two chart instances', () => {
    renderPanel();
    expect(screen.getAllByTestId('echarts-mock')).toHaveLength(2);
  });

  it('wires cpuPercent to the first chart and networkRxBytesPerSec (×8) to the second', () => {
    renderPanel();
    const [cpuChart, netChart] = screen.getAllByTestId('echarts-mock');
    const cpuOpt = JSON.parse(cpuChart.getAttribute('data-option')!);
    const netOpt = JSON.parse(netChart.getAttribute('data-option')!);
    expect(cpuOpt.series[0].data[0][1]).toBe(sampleDataPoints[0].cpuPercent);
    expect(netOpt.series[0].data[0][1]).toBe(sampleDataPoints[0].networkRxBytesPerSec * 8);
  });

  it('renders with empty data points', () => {
    renderPanel({ dataPoints: [] });
    screen.getByText('CPU & Memory');
    screen.getByText('Logs');
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

    screen.getByText('Container Status');
    screen.getByText('Exited');
    screen.getByText('Exit code');
    screen.getByText('137');
    screen.getByText('Finished');
    expect(screen.getAllByText(/2024/)).toHaveLength(2);
  });
});
