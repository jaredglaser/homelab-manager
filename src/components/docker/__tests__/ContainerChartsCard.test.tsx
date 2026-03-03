import { describe, it, expect, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';

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

// Mock xterm.js — CJS modules need default export for bun:test ESM loader
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

const { default: ContainerChartsCard } = await import('../ContainerChartsCard');

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

describe('ContainerChartsCard', () => {
  it('renders two chart sections', () => {
    render(
      <ContainerChartsCard
        dataPoints={sampleDataPoints}
        containerId="abc123"
        host="server"
      />,
    );
    expect(screen.getByText('CPU & Memory')).toBeTruthy();
    expect(screen.getByText('Network I/O')).toBeTruthy();
  });

  it('renders the log viewer', () => {
    render(
      <ContainerChartsCard
        dataPoints={sampleDataPoints}
        containerId="abc123"
        host="server"
      />,
    );
    expect(screen.getByText('Logs')).toBeTruthy();
  });

  it('renders two echarts instances', () => {
    render(
      <ContainerChartsCard
        dataPoints={sampleDataPoints}
        containerId="abc123"
        host="server"
      />,
    );
    const charts = screen.getAllByTestId('echarts-mock');
    expect(charts).toHaveLength(2);
  });

  it('renders with empty data points', () => {
    render(
      <ContainerChartsCard
        dataPoints={[]}
        containerId="abc123"
        host="server"
      />,
    );
    expect(screen.getByText('CPU & Memory')).toBeTruthy();
    expect(screen.getByText('Logs')).toBeTruthy();
  });
});
