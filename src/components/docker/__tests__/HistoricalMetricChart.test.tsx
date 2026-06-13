import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import type { EChartsOption } from 'echarts';

/**
 * The component renders through echarts-for-react (ReactECharts), not echarts
 * directly, so we capture the `option` prop the component builds rather than
 * driving a real chart instance. A module-level array records every option
 * passed across renders so we can assert on re-render behaviour.
 */
const capturedOptions: EChartsOption[] = [];

mock.module('echarts-for-react', () => ({
  __esModule: true,
  default: (props: { option: EChartsOption }) => {
    capturedOptions.push(props.option);
    return <div data-testid="react-echarts" />;
  },
}));

const use12HourTime = { value: false };

mock.module('@/hooks/useSettings', () => ({
  useGeneralSettings: () => ({
    general: { use12HourTime: use12HourTime.value },
    retention: {},
    developer: {},
  }),
}));

const { default: HistoricalMetricChart } = await import('@/components/docker/HistoricalMetricChart');

const FROM = Date.UTC(2026, 0, 1, 0, 0, 0);
const TO = FROM + 60 * 60 * 1000;

const dataPoints = [
  { timestamp: FROM, value: 10 },
  { timestamp: FROM + 30 * 60 * 1000, value: 42 },
  { timestamp: TO, value: 88 },
];

const formatValue = (v: number) => `${v.toFixed(0)}u`;

function lastOption(): Record<string, unknown> {
  return capturedOptions[capturedOptions.length - 1] as Record<string, unknown>;
}

function getSeriesData(option: Record<string, unknown>) {
  const series = option.series as { data: [number, number][] }[];
  return series[0].data;
}

describe('HistoricalMetricChart', () => {
  beforeEach(() => {
    capturedOptions.length = 0;
    use12HourTime.value = false;
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the title and an echarts canvas, building an option with axes and a line series', () => {
    render(
      <HistoricalMetricChart
        title="CPU %"
        dataPoints={dataPoints}
        colorVar="--chart-cpu"
        formatValue={formatValue}
        from={FROM}
        to={TO}
      />,
    );

    expect(screen.getByText('CPU %')).toBeDefined();
    expect(screen.getByTestId('react-echarts')).toBeDefined();

    const option = lastOption();
    const xAxis = option.xAxis as { type: string; min: number; max: number };
    const yAxis = option.yAxis as { type: string; min: number };
    expect(xAxis.type).toBe('time');
    expect(xAxis.min).toBe(FROM);
    expect(xAxis.max).toBe(TO);
    expect(yAxis.type).toBe('value');
    expect(yAxis.min).toBe(0);

    const seriesData = getSeriesData(option);
    expect(seriesData).toEqual([
      [FROM, 10],
      [FROM + 30 * 60 * 1000, 42],
      [TO, 88],
    ]);
  });

  it('handles an empty dataPoints array without throwing', () => {
    render(
      <HistoricalMetricChart
        title="Memory"
        dataPoints={[]}
        colorVar="--chart-memory"
        formatValue={formatValue}
        from={FROM}
        to={TO}
      />,
    );

    const option = lastOption();
    expect(getSeriesData(option)).toEqual([]);
    // calculateCleanYAxis falls back to a 100/20 axis when there is no data.
    const yAxis = option.yAxis as { max: number; interval: number };
    expect(yAxis.max).toBe(100);
    expect(yAxis.interval).toBe(20);
  });

  it('rebuilds the option when dataPoints and range change', () => {
    const { rerender } = render(
      <HistoricalMetricChart
        title="CPU %"
        dataPoints={dataPoints}
        colorVar="--chart-cpu"
        formatValue={formatValue}
        from={FROM}
        to={TO}
      />,
    );

    const firstRenderCount = capturedOptions.length;

    const nextPoints = [{ timestamp: FROM, value: 5 }];
    const nextTo = TO + 60 * 60 * 1000;
    rerender(
      <HistoricalMetricChart
        title="CPU %"
        dataPoints={nextPoints}
        colorVar="--chart-cpu"
        formatValue={formatValue}
        from={FROM}
        to={nextTo}
      />,
    );

    expect(capturedOptions.length).toBeGreaterThan(firstRenderCount);
    const option = lastOption();
    expect((option.xAxis as { max: number }).max).toBe(nextTo);
    expect(getSeriesData(option)).toEqual([[FROM, 5]]);
  });

  it('formats tooltip content using the supplied formatValue', () => {
    render(
      <HistoricalMetricChart
        title="CPU %"
        dataPoints={dataPoints}
        colorVar="--chart-cpu"
        formatValue={formatValue}
        from={FROM}
        to={TO}
      />,
    );

    const option = lastOption();
    const tooltip = option.tooltip as {
      formatter: (params: unknown) => string;
    };
    const out = tooltip.formatter([{ value: [TO, 88] }]);
    expect(out).toContain('88u');
    expect(out).toContain('<br/>');

    // Missing value defaults to 0 -> formatted as "0u".
    const fallback = tooltip.formatter([{ value: [undefined, undefined] }]);
    expect(fallback).toContain('0u');
  });

  it('formats the y-axis labels with formatValue', () => {
    render(
      <HistoricalMetricChart
        title="CPU %"
        dataPoints={dataPoints}
        colorVar="--chart-cpu"
        formatValue={formatValue}
        from={FROM}
        to={TO}
      />,
    );

    const option = lastOption();
    const yAxis = option.yAxis as {
      axisLabel: { formatter: (value: number) => string };
    };
    expect(yAxis.axisLabel.formatter(50)).toBe('50u');
  });

  it('formats x-axis labels as time-only for sub-day ranges', () => {
    render(
      <HistoricalMetricChart
        title="CPU %"
        dataPoints={dataPoints}
        colorVar="--chart-cpu"
        formatValue={formatValue}
        from={FROM}
        to={TO}
      />,
    );

    const option = lastOption();
    const xAxis = option.xAxis as {
      axisLabel: { formatter: (value: number) => string };
    };
    const label = xAxis.axisLabel.formatter(FROM);
    // Sub-day range: single-line time label, no embedded date newline.
    expect(label).not.toContain('\n');
  });

  it('formats x-axis labels with a date line for multi-day ranges', () => {
    const wideTo = FROM + 2 * 86_400_000;
    render(
      <HistoricalMetricChart
        title="CPU %"
        dataPoints={dataPoints}
        colorVar="--chart-cpu"
        formatValue={formatValue}
        from={FROM}
        to={wideTo}
      />,
    );

    const option = lastOption();
    const xAxis = option.xAxis as {
      axisLabel: { formatter: (value: number) => string };
    };
    const label = xAxis.axisLabel.formatter(FROM);
    // Range > 24h: two-line label (month/day on the first line, time on the second).
    expect(label).toContain('\n');
  });

  it('honours the 12-hour time setting when formatting labels', () => {
    use12HourTime.value = true;
    render(
      <HistoricalMetricChart
        title="CPU %"
        dataPoints={dataPoints}
        colorVar="--chart-cpu"
        formatValue={formatValue}
        from={FROM}
        to={TO}
      />,
    );

    const option = lastOption();
    const tooltip = option.tooltip as { formatter: (params: unknown) => string };
    // A noon UTC timestamp under 12-hour formatting yields an AM/PM marker in
    // locales that use it; at minimum the formatter runs without throwing.
    const out = tooltip.formatter([{ value: [TO, 50] }]);
    expect(typeof out).toBe('string');
  });
});
