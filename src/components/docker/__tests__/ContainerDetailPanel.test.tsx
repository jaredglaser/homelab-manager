import { describe, it, expect, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';

// Stub DualSeriesChart to call formatValue so the formatter props are actually exercised
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

// Mock echarts-for-react
mock.module('echarts-for-react', () => ({
  default: ({ option }: { option: unknown }) => (
    <div data-testid="echarts-mock" data-option={JSON.stringify(option)} />
  ),
}));

// Mock useSettings
mock.module('@/hooks/useSettings', () => ({
  useSettings: () => ({
    general: { use12HourTime: false },
    docker: { chartWindowSeconds: 60 },
  }),
}));

// Mock useEChartTimeScroll
mock.module('@/hooks/useEChartTimeScroll', () => ({
  useEChartTimeScroll: () => {},
}));

// Mock xterm.js - CJS modules need default export for bun:test ESM loader
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

// Mock useContainerLogs
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

describe('ContainerDetailPanel', () => {
  it('renders two chart sections', () => {
    render(
      <ContainerDetailPanel
        dataPoints={sampleDataPoints}
        containerId="abc123"
        host="server"
      />,
    );
    screen.getByText('CPU & Memory');
    screen.getByText('Network I/O');
  });

  it('renders the log viewer', () => {
    render(
      <ContainerDetailPanel
        dataPoints={sampleDataPoints}
        containerId="abc123"
        host="server"
      />,
    );
    screen.getByText('Logs');
  });

  it('renders two chart instances', () => {
    render(
      <ContainerDetailPanel
        dataPoints={sampleDataPoints}
        containerId="abc123"
        host="server"
      />,
    );
    const charts = screen.getAllByTestId('dual-series-chart');
    expect(charts).toHaveLength(2);
  });

  it('formats CPU/memory values as percentages and network as bit rate', () => {
    render(
      <ContainerDetailPanel
        dataPoints={sampleDataPoints}
        containerId="abc123"
        host="server"
      />,
    );
    // The mock calls formatValue(1000) for each chart.
    // formatPercent(1000) = formatAsPercent(1000/100) = "1000.00%"
    // formatNetwork(1000) = formatBitsSIUnits(8000, true) = "8.00 Kbps"
    screen.getByText('1000.00%');
    screen.getByText('8.00 Kbps');
  });

  it('renders with empty data points', () => {
    render(
      <ContainerDetailPanel
        dataPoints={[]}
        containerId="abc123"
        host="server"
      />,
    );
    screen.getByText('CPU & Memory');
    screen.getByText('Logs');
  });
});
