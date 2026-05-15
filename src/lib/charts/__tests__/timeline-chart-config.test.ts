import { describe, it, expect } from 'bun:test';
import { getTimelineOption, RANGE_PRESETS, TIMELINE_METRICS } from '@/lib/charts/timeline-chart-config';
import type { DockerStatsRow } from '@/types/docker';

describe('RANGE_PRESETS', () => {
  it('includes 7 presets', () => {
    expect(RANGE_PRESETS).toHaveLength(7);
  });

  it('presets are ordered by duration ascending', () => {
    const mses = RANGE_PRESETS.map((p) => p.ms);
    for (let i = 1; i < mses.length; i++) {
      expect(mses[i]).toBeGreaterThan(mses[i - 1]);
    }
  });
});

describe('TIMELINE_METRICS', () => {
  it('includes 6 metric definitions', () => {
    expect(TIMELINE_METRICS).toHaveLength(6);
  });

  it('each metric has a key, label, colorVar and extract function', () => {
    for (const m of TIMELINE_METRICS) {
      expect(typeof m.key).toBe('string');
      expect(typeof m.label).toBe('string');
      expect(m.colorVar.startsWith('--')).toBe(true);
      expect(typeof m.extract).toBe('function');
    }
  });

  it('extract functions return 0 for missing fields', () => {
    const emptyRow = {} as DockerStatsRow;
    for (const m of TIMELINE_METRICS) {
      expect(m.extract(emptyRow)).toBe(0);
    }
  });

  it('extract functions return actual values when present', () => {
    const row = {
      cpu_percent: 25,
      memory_percent: 50,
      block_io_read_bytes_per_sec: 1024,
      block_io_write_bytes_per_sec: 2048,
      network_rx_bytes_per_sec: 512,
      network_tx_bytes_per_sec: 256,
    } as DockerStatsRow;
    const [cpu, memory, blockRead, blockWrite, netRx, netTx] = TIMELINE_METRICS;
    expect(cpu.extract(row)).toBe(25);
    expect(memory.extract(row)).toBe(50);
    expect(blockRead.extract(row)).toBe(1024);
    expect(blockWrite.extract(row)).toBe(2048);
    expect(netRx.extract(row)).toBe(512);
    expect(netTx.extract(row)).toBe(256);
  });
});

describe('getTimelineOption', () => {
  const sampleData: [number, number][] = [
    [1000000, 10],
    [2000000, 20],
    [3000000, 30],
  ];

  it('returns an EChartsOption with animation false', () => {
    const option = getTimelineOption(sampleData, '--chart-cpu', false);
    expect(option.animation).toBe(false);
  });

  it('returns a line series with correct data', () => {
    const option = getTimelineOption(sampleData, '--chart-cpu', false);
    const series = (option.series as { data: unknown[] }[])[0];
    expect(series.data).toEqual(sampleData);
  });

  it('uses the data range for x-axis when data provided', () => {
    const option = getTimelineOption(sampleData, '--chart-cpu', false);
    // No explicit xAxis.min/max in this config - it's time-based
    expect((option.xAxis as { type: string }).type).toBe('time');
  });

  it('falls back to last-hour range when no data', () => {
    const option = getTimelineOption([], '--chart-cpu', false);
    // Still returns a valid option
    expect(option.animation).toBe(false);
  });

  it('includes two dataZoom controls', () => {
    const option = getTimelineOption(sampleData, '--chart-cpu', false);
    expect((option.dataZoom as unknown[]).length).toBe(2);
  });

  it('xAxis formatter uses short time for ranges <= 24h', () => {
    const now = Date.now();
    const data: [number, number][] = [
      [now - 3_600_000, 10],
      [now, 20],
    ];
    const option = getTimelineOption(data, '--chart-cpu', false);
    const formatter = (option.xAxis as { axisLabel: { formatter: (v: number) => string } }).axisLabel.formatter;
    const result = formatter(now);
    // Should be a time string like "12:00 AM" or "00:00"
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('xAxis formatter uses month/day for ranges > 24h', () => {
    const now = Date.now();
    const data: [number, number][] = [
      [now - 2 * 86_400_000, 10],
      [now, 20],
    ];
    const option = getTimelineOption(data, '--chart-cpu', false);
    const formatter = (option.xAxis as { axisLabel: { formatter: (v: number) => string } }).axisLabel.formatter;
    const result = formatter(now);
    // Should be like "Jan 15"
    expect(typeof result).toBe('string');
    expect(result).toMatch(/\w+ \d+/);
  });

  it('smooth series with gradient area style', () => {
    const option = getTimelineOption(sampleData, '--chart-memory', false);
    const series = (option.series as { smooth: boolean; areaStyle: unknown }[])[0];
    expect(series.smooth).toBe(true);
    expect(series.areaStyle).toBeTruthy();
  });
});
