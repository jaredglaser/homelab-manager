import { describe, it, expect, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';

mock.module('@/hooks/useSettings', () => ({
  useSettings: () => ({
    general: { use12HourTime: false },
    docker: { chartWindowSeconds: 60 },
  }),
}));

mock.module('@/hooks/useEChartTimeScroll', () => ({
  useEChartTimeScroll: () => {},
}));

mock.module('@/components/docker/DualSeriesChart', () => ({
  default: ({
    title,
    formatValue,
  }: {
    title?: string;
    formatValue?: (v: number) => string;
  }) => (
    <div data-testid="dual-series-chart">
      {title && <span>{title}</span>}
      {formatValue && <span data-testid="format-value-output">{formatValue(1000)}</span>}
    </div>
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

function renderPanel(overrides: Partial<ComponentProps<typeof ContainerDetailPanel>> = {}) {
  return render(
    <ContainerDetailPanel
      dataPoints={sampleDataPoints}
      containerId="abc123"
      host="server"
      {...overrides}
    />,
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
    const charts = screen.getAllByTestId('dual-series-chart');
    expect(charts).toHaveLength(2);
  });

  it('formats CPU/memory values as percentages and network as bit rate', () => {
    renderPanel();
    screen.getByText('1000.00%');
    screen.getByText('1.00 Kbps');
  });

  it('renders with empty data points', () => {
    renderPanel({ dataPoints: [] });
    screen.getByText('CPU & Memory');
    screen.getByText('Logs');
  });
});
