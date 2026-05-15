import { describe, it, expect, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
import type { EChartsOption } from 'echarts';

mock.module('@/hooks/useSettings', () => ({
  useGeneralSettings: () => ({ general: { use12HourTime: false } }),
}));

mock.module('@/lib/charts/css-vars', () => ({
  resolveChartColors: () => ({
    line: '#aaa',
    areaStart: 'rgba(0,0,0,0.3)',
    areaEnd: 'rgba(0,0,0,0)',
  }),
  resolveChartChromeColors: () => ({
    tooltipBg: '#fff',
    border: '#ccc',
    tooltipText: '#000',
    textMuted: '#999',
  }),
}));

mock.module('@/lib/charts/y-axis', () => ({
  calculateCleanYAxis: () => ({ max: 100, interval: 25 }),
}));

// Capture the live option object so tests can invoke formatter functions
let capturedOption: EChartsOption | null = null;
mock.module('echarts-for-react', () => ({
  default: ({ option }: { option: EChartsOption }) => {
    capturedOption = option;
    return <div data-testid="echarts-mock" data-option={JSON.stringify(option)} />;
  },
}));

const { default: HistoricalMetricChart } = await import('@/components/docker/HistoricalMetricChart');

const sampleDataPoints = [
  { timestamp: 1000000, value: 10 },
  { timestamp: 2000000, value: 20 },
  { timestamp: 3000000, value: 30 },
];

describe('HistoricalMetricChart', () => {
  it('renders the chart title', () => {
    render(
      <HistoricalMetricChart
        title="CPU %"
        dataPoints={sampleDataPoints}
        colorVar="--chart-cpu"
        formatValue={(v) => `${v}%`}
        from={1000000}
        to={3000000}
      />,
    );
    screen.getByText('CPU %');
  });

  it('renders the echarts component', () => {
    render(
      <HistoricalMetricChart
        title="Memory %"
        dataPoints={sampleDataPoints}
        colorVar="--chart-memory"
        formatValue={(v) => `${v}%`}
        from={1000000}
        to={3000000}
      />,
    );
    expect(screen.getByTestId('echarts-mock')).toBeTruthy();
  });

  it('passes data points to the chart as [timestamp, value] pairs', () => {
    render(
      <HistoricalMetricChart
        title="CPU %"
        dataPoints={sampleDataPoints}
        colorVar="--chart-cpu"
        formatValue={(v) => `${v}%`}
        from={1000000}
        to={3000000}
      />,
    );
    const el = screen.getByTestId('echarts-mock');
    const option = JSON.parse(el.getAttribute('data-option')!);
    expect(option.series[0].data).toEqual([
      [1000000, 10],
      [2000000, 20],
      [3000000, 30],
    ]);
  });

  it('sets xAxis min/max from from/to props', () => {
    render(
      <HistoricalMetricChart
        title="CPU %"
        dataPoints={sampleDataPoints}
        colorVar="--chart-cpu"
        formatValue={(v) => `${v}%`}
        from={1000000}
        to={5000000}
      />,
    );
    const el = screen.getByTestId('echarts-mock');
    const option = JSON.parse(el.getAttribute('data-option')!);
    expect(option.xAxis.min).toBe(1000000);
    expect(option.xAxis.max).toBe(5000000);
  });

  it('renders with empty data points', () => {
    render(
      <HistoricalMetricChart
        title="CPU %"
        dataPoints={[]}
        colorVar="--chart-cpu"
        formatValue={(v) => `${v}%`}
        from={0}
        to={1000000}
      />,
    );
    expect(screen.getByTestId('echarts-mock')).toBeTruthy();
  });

  it('uses time type xAxis', () => {
    render(
      <HistoricalMetricChart
        title="CPU %"
        dataPoints={sampleDataPoints}
        colorVar="--chart-cpu"
        formatValue={(v) => `${v}%`}
        from={1000000}
        to={3000000}
      />,
    );
    const el = screen.getByTestId('echarts-mock');
    const option = JSON.parse(el.getAttribute('data-option')!);
    expect(option.xAxis.type).toBe('time');
  });

  it('disables animation', () => {
    render(
      <HistoricalMetricChart
        title="CPU %"
        dataPoints={sampleDataPoints}
        colorVar="--chart-cpu"
        formatValue={(v) => `${v}%`}
        from={1000000}
        to={3000000}
      />,
    );
    const el = screen.getByTestId('echarts-mock');
    const option = JSON.parse(el.getAttribute('data-option')!);
    expect(option.animation).toBe(false);
  });

  it('uses a smooth line series with area style', () => {
    render(
      <HistoricalMetricChart
        title="CPU %"
        dataPoints={sampleDataPoints}
        colorVar="--chart-cpu"
        formatValue={(v) => `${v}%`}
        from={1000000}
        to={3000000}
      />,
    );
    const el = screen.getByTestId('echarts-mock');
    const option = JSON.parse(el.getAttribute('data-option')!);
    const series = option.series[0];
    expect(series.smooth).toBe(true);
    expect(series.areaStyle).toBeTruthy();
    expect(series.type).toBe('line');
  });
});

describe('formatTimeLabel (via chart xAxis formatter)', () => {
  it('xAxis formatter returns a short time string for ranges <= 24h', () => {
    const now = Date.now();
    render(
      <HistoricalMetricChart
        title="CPU %"
        dataPoints={[{ timestamp: now - 3_600_000, value: 10 }, { timestamp: now, value: 20 }]}
        colorVar="--chart-cpu"
        formatValue={(v) => `${v}%`}
        from={now - 3_600_000}
        to={now}
      />,
    );
    const formatter = (capturedOption!.xAxis as { axisLabel: { formatter: (v: number) => string } }).axisLabel.formatter;
    const result = formatter(now);
    expect(typeof result).toBe('string');
    // Short time: no newline, just H:M:S
    expect(result).not.toContain('\n');
  });

  it('xAxis formatter returns month/day + time for ranges > 24h', () => {
    const now = Date.now();
    render(
      <HistoricalMetricChart
        title="CPU %"
        dataPoints={[{ timestamp: now - 2 * 86_400_000, value: 10 }, { timestamp: now, value: 20 }]}
        colorVar="--chart-cpu"
        formatValue={(v) => `${v}%`}
        from={now - 2 * 86_400_000}
        to={now}
      />,
    );
    const formatter = (capturedOption!.xAxis as { axisLabel: { formatter: (v: number) => string } }).axisLabel.formatter;
    const result = formatter(now);
    expect(typeof result).toBe('string');
    // Long range: should contain newline separating date and time
    expect(result).toContain('\n');
    expect(result).toMatch(/\w+ \d+/);
  });

  it('tooltip formatter returns formatted time + value string', () => {
    const now = Date.now();
    render(
      <HistoricalMetricChart
        title="CPU %"
        dataPoints={[{ timestamp: now, value: 42 }]}
        colorVar="--chart-cpu"
        formatValue={(v) => `${v}%`}
        from={now - 3_600_000}
        to={now}
      />,
    );
    const tooltipFormatter = (capturedOption!.tooltip as { formatter: (params: unknown) => string }).formatter;
    const result = tooltipFormatter([{ value: [now, 42] }]);
    expect(result).toContain('42%');
    expect(result).toContain('<br/>');
  });

  it('tooltip formatter handles missing timestamp gracefully', () => {
    const now = Date.now();
    render(
      <HistoricalMetricChart
        title="CPU %"
        dataPoints={[{ timestamp: now, value: 5 }]}
        colorVar="--chart-cpu"
        formatValue={(v) => `${v}%`}
        from={now - 3_600_000}
        to={now}
      />,
    );
    const tooltipFormatter = (capturedOption!.tooltip as { formatter: (params: unknown) => string }).formatter;
    const result = tooltipFormatter([{ value: [null, 5] }]);
    expect(result).toContain('5%');
  });
});
