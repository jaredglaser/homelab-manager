import { describe, it, expect, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';

// Mock echarts-for-react — canvas rendering not available in Happy-DOM
mock.module('echarts-for-react', () => ({
  default: ({ option }: { option: unknown }) => (
    <div data-testid="echarts-mock" data-option={JSON.stringify(option)} />
  ),
}));

// Mock useSettings to return stable defaults
mock.module('@/hooks/useSettings', () => ({
  useSettings: () => ({
    general: { use12HourTime: false },
    docker: { chartWindowSeconds: 60 },
  }),
}));

// Mock useEChartTimeScroll — no-op in tests
mock.module('@/hooks/useEChartTimeScroll', () => ({
  useEChartTimeScroll: () => {},
}));

// Must import after mocks
const { default: DualSeriesChart } = await import('../DualSeriesChart');

const baseSeries: [
  { name: string; dataPoints: { timestamp: number; value: number }[]; colorVar: string },
  { name: string; dataPoints: { timestamp: number; value: number }[]; colorVar: string },
] = [
  {
    name: 'CPU',
    dataPoints: [
      { timestamp: 1000, value: 25 },
      { timestamp: 2000, value: 50 },
    ],
    colorVar: '--chart-cpu',
  },
  {
    name: 'Memory',
    dataPoints: [
      { timestamp: 1000, value: 40 },
      { timestamp: 2000, value: 60 },
    ],
    colorVar: '--chart-memory',
  },
];

describe('DualSeriesChart', () => {
  it('renders title', () => {
    render(
      <DualSeriesChart
        title="CPU & Memory"
        series={baseSeries}
        yAxisMode="percent"
        formatValue={(v) => `${v}%`}
      />,
    );
    expect(screen.getByText('CPU & Memory')).toBeTruthy();
  });

  it('renders echarts component', () => {
    render(
      <DualSeriesChart
        title="Network I/O"
        series={baseSeries}
        yAxisMode="bytes"
        formatValue={(v) => `${v} B/s`}
      />,
    );
    expect(screen.getByTestId('echarts-mock')).toBeTruthy();
  });

  it('passes two series to echarts option', () => {
    render(
      <DualSeriesChart
        title="Test"
        series={baseSeries}
        yAxisMode="percent"
        formatValue={(v) => `${v}%`}
      />,
    );
    const chartEl = screen.getByTestId('echarts-mock');
    const option = JSON.parse(chartEl.getAttribute('data-option')!);
    expect(option.series).toHaveLength(2);
    expect(option.series[0].name).toBe('CPU');
    expect(option.series[1].name).toBe('Memory');
  });

  it('passes correct data points to each series', () => {
    render(
      <DualSeriesChart
        title="Test"
        series={baseSeries}
        yAxisMode="percent"
        formatValue={(v) => `${v}%`}
      />,
    );
    const chartEl = screen.getByTestId('echarts-mock');
    const option = JSON.parse(chartEl.getAttribute('data-option')!);
    expect(option.series[0].data).toEqual([[1000, 25], [2000, 50]]);
    expect(option.series[1].data).toEqual([[1000, 40], [2000, 60]]);
  });

  it('renders with empty data points', () => {
    const emptySeries: typeof baseSeries = [
      { name: 'A', dataPoints: [], colorVar: '--chart-cpu' },
      { name: 'B', dataPoints: [], colorVar: '--chart-memory' },
    ];
    render(
      <DualSeriesChart
        title="Empty"
        series={emptySeries}
        yAxisMode="percent"
        formatValue={(v) => `${v}%`}
      />,
    );
    expect(screen.getByText('Empty')).toBeTruthy();
  });
});
