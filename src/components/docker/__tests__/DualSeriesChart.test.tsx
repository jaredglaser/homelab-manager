import { describe, it, expect, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';

// Mock echarts-for-react - canvas rendering not available in Happy-DOM
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

// Mock useEChartTimeScroll - no-op in tests
mock.module('@/hooks/useEChartTimeScroll', () => ({
  useEChartTimeScroll: () => {},
}));

// Must import after mocks
const { default: DualSeriesChart, getChartOption } = await import('../DualSeriesChart');

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

describe('getChartOption', () => {
  const formatValue = (v: number) => `${v}%`;

  it('tooltip formatter returns formatted lines for both series', () => {
    const option = getChartOption(baseSeries, 'percent', formatValue, false, 60000);
    const formatter = (option.tooltip as { formatter: Function }).formatter;
    const result = formatter([
      { value: [1000, 25], marker: '●', seriesName: 'CPU' },
      { value: [1000, 40], marker: '●', seriesName: 'Memory' },
    ]);
    expect(result).toContain('CPU: 25%');
    expect(result).toContain('Memory: 40%');
  });

  it('tooltip formatter handles empty params', () => {
    const option = getChartOption(baseSeries, 'percent', formatValue, false, 60000);
    const formatter = (option.tooltip as { formatter: Function }).formatter;
    const result = formatter([]);
    expect(result).toContain('<br/>');
  });

  it('xAxis formatter formats minutes and seconds', () => {
    const option = getChartOption(baseSeries, 'percent', formatValue, false, 60000);
    const xAxisFormatter = (option.xAxis as { axisLabel: { formatter: Function } }).axisLabel.formatter;
    // Test with a known timestamp: 2024-01-01 00:05:30
    const ts = new Date(2024, 0, 1, 0, 5, 30).getTime();
    expect(xAxisFormatter(ts)).toBe('05:30');
  });

  it('yAxis formatter uses formatValue', () => {
    const option = getChartOption(baseSeries, 'percent', formatValue, false, 60000);
    const yAxisFormatter = (option.yAxis as { axisLabel: { formatter: Function } }).axisLabel.formatter;
    expect(yAxisFormatter(50)).toBe('50%');
  });

  it('sets itemStyle.color on each series', () => {
    const option = getChartOption(baseSeries, 'percent', formatValue, false, 60000);
    const series = option.series as { itemStyle: { color: string } }[];
    expect(series[0].itemStyle).toBeDefined();
    expect(series[1].itemStyle).toBeDefined();
  });
});
