import { describe, it, expect, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { DockerStatsRow } from '@/types/docker';
import type { MetricType } from '@/components/docker/MetricCheckboxes';

mock.module('@/components/docker/HistoricalMetricChart', () => ({
  default: (props: {
    title: string;
    dataPoints: { timestamp: number; value: number }[];
    colorVar: string;
    from: number;
    to: number;
  }) => (
    <div
      data-testid="metric-chart"
      data-title={props.title}
      data-color={props.colorVar}
      data-from={props.from}
      data-to={props.to}
      data-points={JSON.stringify(props.dataPoints)}
    />
  ),
}));

const { default: HistoricalChartsGrid } = await import('@/components/docker/HistoricalChartsGrid');

function makeRow(overrides: Partial<DockerStatsRow> = {}): DockerStatsRow {
  return {
    time: '2024-01-01T00:00:00Z',
    host: 'server',
    container_id: 'abc123',
    container_name: 'nginx',
    image: null,
    cpu_percent: 25,
    memory_percent: 50,
    memory_usage: 0,
    memory_limit: 0,
    block_io_read_bytes_per_sec: 100,
    block_io_write_bytes_per_sec: 200,
    network_rx_bytes_per_sec: 300,
    network_tx_bytes_per_sec: 400,
    ...overrides,
  } as DockerStatsRow;
}

const sampleData: DockerStatsRow[] = [
  makeRow({ time: '2024-01-01T00:00:00Z' }),
  makeRow({ time: '2024-01-01T00:00:01Z', cpu_percent: 30 }),
];

function renderGrid(overrides: Partial<ComponentProps<typeof HistoricalChartsGrid>> = {}) {
  return render(
    <HistoricalChartsGrid
      data={sampleData}
      selectedMetrics={new Set<MetricType>(['cpu', 'memory'])}
      from={1000}
      to={2000}
      {...overrides}
    />,
  );
}

describe('HistoricalChartsGrid', () => {
  it('renders one chart per selected metric', () => {
    renderGrid({ selectedMetrics: new Set<MetricType>(['cpu', 'memory', 'networkRx']) });
    expect(screen.getAllByTestId('metric-chart')).toHaveLength(3);
  });

  it('renders charts in selection insertion order with the configured titles', () => {
    renderGrid({ selectedMetrics: new Set<MetricType>(['memory', 'cpu']) });
    const titles = screen.getAllByTestId('metric-chart').map((el) => el.getAttribute('data-title'));
    expect(titles).toEqual(['Memory %', 'CPU %']);
  });

  it('renders no charts when no metrics are selected', () => {
    renderGrid({ selectedMetrics: new Set<MetricType>() });
    expect(screen.queryAllByTestId('metric-chart')).toHaveLength(0);
  });

  it('uses a single-column grid for one metric', () => {
    const { container } = renderGrid({ selectedMetrics: new Set<MetricType>(['cpu']) });
    const grid = container.firstChild as HTMLElement;
    expect(grid.className).toContain('grid-cols-1');
    expect(grid.className).not.toContain('xl:grid-cols-2');
  });

  it('uses a two-column grid for multiple metrics', () => {
    const { container } = renderGrid({ selectedMetrics: new Set<MetricType>(['cpu', 'memory']) });
    const grid = container.firstChild as HTMLElement;
    expect(grid.className).toContain('xl:grid-cols-2');
  });

  it('extracts metric values from rows into data points', () => {
    renderGrid({ selectedMetrics: new Set<MetricType>(['cpu']) });
    const points = JSON.parse(
      screen.getByTestId('metric-chart').getAttribute('data-points') ?? '[]',
    ) as { timestamp: number; value: number }[];
    expect(points).toHaveLength(2);
    expect(points[0].value).toBe(25);
    expect(points[1].value).toBe(30);
    expect(points[0].timestamp).toBe(new Date('2024-01-01T00:00:00Z').getTime());
  });

  it('defaults missing metric fields to zero', () => {
    renderGrid({
      data: [makeRow({ cpu_percent: undefined })],
      selectedMetrics: new Set<MetricType>(['cpu']),
    });
    const points = JSON.parse(
      screen.getByTestId('metric-chart').getAttribute('data-points') ?? '[]',
    ) as { value: number }[];
    expect(points[0].value).toBe(0);
  });

  it('passes the from and to bounds and the metric color through to each chart', () => {
    renderGrid({ selectedMetrics: new Set<MetricType>(['blockRead']), from: 5, to: 9 });
    const chart = screen.getByTestId('metric-chart');
    expect(chart.getAttribute('data-from')).toBe('5');
    expect(chart.getAttribute('data-to')).toBe('9');
    expect(chart.getAttribute('data-color')).toBe('--chart-read');
  });

  it('renders all six metric types when fully selected', () => {
    renderGrid({
      selectedMetrics: new Set<MetricType>([
        'cpu',
        'memory',
        'blockRead',
        'blockWrite',
        'networkRx',
        'networkTx',
      ]),
    });
    expect(screen.getAllByTestId('metric-chart')).toHaveLength(6);
  });
});
