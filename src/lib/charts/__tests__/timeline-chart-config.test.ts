import { describe, it, expect, beforeEach } from 'bun:test';
import type { LineSeriesOption, XAXisComponentOption } from 'echarts';
import { getTimelineOption, RANGE_PRESETS, TIMELINE_METRICS } from '@/lib/charts/timeline-chart-config';
import type { DockerStatsRow } from '@/types/docker';

/**
 * Narrow the axisLabel formatter from the option's xAxis. ECharts types it as a
 * broad union, so cast to the time-axis shape to reach `formatter`.
 */
function getXAxisFormatter(
  xAxis: ReturnType<typeof getTimelineOption>['xAxis'],
): (value: number) => string {
  const axis = xAxis as XAXisComponentOption;
  const formatter = axis.axisLabel?.formatter;
  if (typeof formatter !== 'function') {
    throw new Error('expected axisLabel.formatter to be a function');
  }
  return formatter as (value: number) => string;
}

describe('getTimelineOption', () => {
  beforeEach(() => {
    document.documentElement.style.cssText = '';
    document.documentElement.style.setProperty('--chart-cpu', 'rgb(249, 115, 22)');
    document.documentElement.style.setProperty('--chart-cpu-area-start', 'rgba(249, 115, 22, 0.3)');
    document.documentElement.style.setProperty('--chart-cpu-area-end', 'rgba(249, 115, 22, 0.02)');
    document.documentElement.style.setProperty('--chart-text-muted', '#94a3b8');
  });

  it('builds the static chart chrome (grid, axes, dataZoom, series shape)', () => {
    const data: [number, number][] = [
      [1_000, 10],
      [2_000, 20],
    ];

    const option = getTimelineOption(data, '--chart-cpu', false);

    expect(option.animation).toBe(false);
    expect(option.grid).toEqual({ top: 10, right: 15, bottom: 80, left: 55 });

    const yAxis = option.yAxis as { type: string; min: number; show: boolean };
    expect(yAxis.type).toBe('value');
    expect(yAxis.min).toBe(0);
    expect(yAxis.show).toBe(false);

    const dataZoom = option.dataZoom as Array<{ type?: string; start: number; end: number }>;
    expect(dataZoom).toHaveLength(2);
    expect(dataZoom[0]).toEqual({ type: 'inside', start: 0, end: 100 });
    expect(dataZoom[1]).toEqual({ start: 0, end: 100 });

    const xAxis = option.xAxis as XAXisComponentOption;
    expect(xAxis.type).toBe('time');
    expect(xAxis.axisLine).toEqual({ show: false });
    expect(xAxis.axisTick).toEqual({ show: false });
    expect(xAxis.splitLine).toEqual({ show: false });
    expect(xAxis.axisLabel?.color).toBe('#94a3b8');
  });

  it('resolves series colors from the supplied color variable', () => {
    const data: [number, number][] = [[1_000, 5]];

    const option = getTimelineOption(data, '--chart-cpu', false);
    const series = (option.series as LineSeriesOption[])[0];

    expect(series.type).toBe('line');
    expect(series.smooth).toBe(true);
    expect(series.showSymbol).toBe(false);
    expect(series.sampling).toBe('lttb');
    expect(series.data).toBe(data);
    expect(series.lineStyle).toEqual({ color: 'rgb(249, 115, 22)', width: 1 });

    const areaColor = series.areaStyle?.color as {
      type: string;
      x: number;
      y: number;
      x2: number;
      y2: number;
      colorStops: { offset: number; color: string }[];
    };
    expect(areaColor.type).toBe('linear');
    expect(areaColor).toMatchObject({ x: 0, y: 0, x2: 0, y2: 1 });
    expect(areaColor.colorStops).toEqual([
      { offset: 0, color: 'rgba(249, 115, 22, 0.3)' },
      { offset: 1, color: 'rgba(249, 115, 22, 0.02)' },
    ]);
  });

  it('falls back to a one-hour window when series data is empty', () => {
    const before = Date.now();
    const option = getTimelineOption([], '--chart-cpu', false);
    const after = Date.now();

    const series = (option.series as LineSeriesOption[])[0];
    expect(series.data).toEqual([]);

    // With empty data the formatter uses Date.now()-based bounds (~1h span),
    // so it must take the time-of-day branch, not the month/day branch.
    const formatter = getXAxisFormatter(option.xAxis);
    const sample = formatter((before + after) / 2);
    expect(sample).toMatch(/\d{1,2}:\d{2}/);
  });

  it('formats labels as time-of-day for ranges up to 24h', () => {
    const start = Date.UTC(2026, 5, 12, 9, 0, 0);
    const data: [number, number][] = [
      [start, 1],
      [start + 3_600_000, 2], // 1h span
    ];

    const option = getTimelineOption(data, '--chart-cpu', false);
    const formatter = getXAxisFormatter(option.xAxis);
    const label = formatter(start);

    // 24-hour clock: HH:MM with no AM/PM marker.
    expect(label).toMatch(/^\d{1,2}:\d{2}$/);
    expect(label).not.toMatch(/[AaPp][Mm]/);
  });

  it('uses a 12-hour clock when use12HourTime is true', () => {
    const start = Date.UTC(2026, 5, 12, 21, 0, 0);
    const data: [number, number][] = [
      [start, 1],
      [start + 1_800_000, 2], // 30m span, under 24h
    ];

    const option = getTimelineOption(data, '--chart-cpu', true);
    const formatter = getXAxisFormatter(option.xAxis);
    const label = formatter(start);

    expect(label).toMatch(/[AaPp][Mm]/);
  });

  it('formats labels as month/day for ranges longer than 24h', () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const data: [number, number][] = [
      [start, 1],
      [start + 3 * 86_400_000, 2], // 3-day span, over 24h
    ];

    const option = getTimelineOption(data, '--chart-cpu', false);
    const formatter = getXAxisFormatter(option.xAxis);
    const label = formatter(start + 86_400_000);

    // Month/day branch: short month name followed by a day number.
    expect(label).toMatch(/^[A-Za-z]{3,} \d{1,2}$/);
    expect(label).not.toMatch(/:/);
  });

  it('returns empty color strings when the color variable is unset', () => {
    document.documentElement.style.cssText = '';
    const option = getTimelineOption([[1, 1]], '--chart-missing', false);
    const series = (option.series as LineSeriesOption[])[0];
    expect(series.lineStyle).toEqual({ color: '', width: 1 });
  });
});

describe('RANGE_PRESETS', () => {
  it('lists presets in ascending duration order', () => {
    const millis = RANGE_PRESETS.map((p) => p.ms);
    const sorted = [...millis].sort((a, b) => a - b);
    expect(millis).toEqual(sorted);
    expect(RANGE_PRESETS.map((p) => p.label)).toContain('1h');
    expect(RANGE_PRESETS.find((p) => p.label === '1d')?.ms).toBe(86_400_000);
  });
});

describe('TIMELINE_METRICS', () => {
  const baseRow: DockerStatsRow = {
    cpu_percent: 12.5,
    memory_percent: 34.5,
    block_io_read_bytes_per_sec: 1_000,
    block_io_write_bytes_per_sec: 2_000,
    network_rx_bytes_per_sec: 3_000,
    network_tx_bytes_per_sec: 4_000,
  } as unknown as DockerStatsRow;

  it('extracts the matching field for each metric', () => {
    const byKey = Object.fromEntries(TIMELINE_METRICS.map((m) => [m.key, m]));
    expect(byKey.cpu.extract(baseRow)).toBe(12.5);
    expect(byKey.memory.extract(baseRow)).toBe(34.5);
    expect(byKey.blockRead.extract(baseRow)).toBe(1_000);
    expect(byKey.blockWrite.extract(baseRow)).toBe(2_000);
    expect(byKey.networkRx.extract(baseRow)).toBe(3_000);
    expect(byKey.networkTx.extract(baseRow)).toBe(4_000);
  });

  it('falls back to 0 when a field is null or undefined', () => {
    const emptyRow = {} as DockerStatsRow;
    for (const metric of TIMELINE_METRICS) {
      expect(metric.extract(emptyRow)).toBe(0);
    }
  });
});
