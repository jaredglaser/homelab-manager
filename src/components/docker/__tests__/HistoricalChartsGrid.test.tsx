import { describe, it, expect, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
import type { DockerStatsRow } from '@/types/docker';

mock.module('@/components/docker/HistoricalMetricChart', () => ({
  default: ({ title }: { title: string }) => <div data-testid={`chart-${title}`}>{title}</div>,
}));

const { default: HistoricalChartsGrid } = await import('@/components/docker/HistoricalChartsGrid');

const sampleRow: DockerStatsRow = {
  time: new Date('2024-01-01T00:00:00Z').toISOString() as never,
  cpu_percent: 25,
  memory_percent: 50,
  block_io_read_bytes_per_sec: 1024,
  block_io_write_bytes_per_sec: 2048,
  network_rx_bytes_per_sec: 512,
  network_tx_bytes_per_sec: 256,
} as unknown as DockerStatsRow;

describe('HistoricalChartsGrid', () => {
  it('renders a chart for each selected metric', () => {
    render(
      <HistoricalChartsGrid
        data={[sampleRow]}
        selectedMetrics={new Set(['cpu', 'memory'])}
        from={0}
        to={1000}
      />,
    );
    screen.getByTestId('chart-CPU %');
    screen.getByTestId('chart-Memory %');
  });

  it('renders nothing when no metrics selected', () => {
    const { container } = render(
      <HistoricalChartsGrid
        data={[sampleRow]}
        selectedMetrics={new Set([])}
        from={0}
        to={1000}
      />,
    );
    // No chart elements
    expect(container.querySelectorAll('[data-testid^="chart-"]')).toHaveLength(0);
  });

  it('renders all six metrics when all are selected', () => {
    render(
      <HistoricalChartsGrid
        data={[sampleRow]}
        selectedMetrics={new Set(['cpu', 'memory', 'blockRead', 'blockWrite', 'networkRx', 'networkTx'])}
        from={0}
        to={1000}
      />,
    );
    screen.getByTestId('chart-CPU %');
    screen.getByTestId('chart-Memory %');
    screen.getByTestId('chart-Block Read');
    screen.getByTestId('chart-Block Write');
    screen.getByTestId('chart-Network RX');
    screen.getByTestId('chart-Network TX');
  });

  it('renders with empty data', () => {
    render(
      <HistoricalChartsGrid
        data={[]}
        selectedMetrics={new Set(['cpu'])}
        from={0}
        to={1000}
      />,
    );
    screen.getByTestId('chart-CPU %');
  });
});
