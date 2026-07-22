import { describe, it, expect } from 'bun:test';
import type { DockerStatsRowRevived } from '@/types/docker';

const { buildContainerChartData, useContainerChartData } = await import('@/hooks/useContainerChartData');
const { renderHook } = await import('@testing-library/react');

/** Minimal valid DockerStatsRowRevived with all nullable fields null */
function makeRow(overrides: Partial<DockerStatsRowRevived> = {}): DockerStatsRowRevived {
  return {
    time: Date.parse('2024-01-01T00:00:00.000Z'),
    host: 'testhost',
    container_id: 'abc123',
    container_name: 'test-container',
    image: 'nginx:latest',
    cpu_percent: null,
    memory_usage: null,
    memory_limit: null,
    memory_percent: null,
    network_rx_bytes_per_sec: null,
    network_tx_bytes_per_sec: null,
    block_io_read_bytes_per_sec: null,
    block_io_write_bytes_per_sec: null,
    ...overrides,
  };
}

describe('buildContainerChartData', () => {
  it('returns empty arrays for empty input', () => {
    const result = buildContainerChartData([]);

    expect(result.dataPoints).toEqual([]);
    expect(result.sparklineData.cpu).toEqual([]);
    expect(result.sparklineData.memory).toEqual([]);
    expect(result.sparklineData.blockRead).toEqual([]);
    expect(result.sparklineData.blockWrite).toEqual([]);
    expect(result.sparklineData.networkRx).toEqual([]);
    expect(result.sparklineData.networkTx).toEqual([]);
  });

  it('maps a single row to correct ChartDataPoint fields', () => {
    const time = Date.parse('2024-06-15T12:00:00.000Z');
    const row = makeRow({
      time,
      cpu_percent: 42.5,
      memory_percent: 30.1,
      block_io_read_bytes_per_sec: 1024,
      block_io_write_bytes_per_sec: 2048,
      network_rx_bytes_per_sec: 512,
      network_tx_bytes_per_sec: 256,
    });

    const { dataPoints, sparklineData } = buildContainerChartData([row]);

    expect(dataPoints).toHaveLength(1);
    const point = dataPoints[0];
    expect(point.timestamp).toBe(time);
    expect(point.cpuPercent).toBe(42.5);
    expect(point.memoryPercent).toBe(30.1);
    expect(point.blockIoReadBytesPerSec).toBe(1024);
    expect(point.blockIoWriteBytesPerSec).toBe(2048);
    expect(point.networkRxBytesPerSec).toBe(512);
    expect(point.networkTxBytesPerSec).toBe(256);

    // Sparklines should mirror the same values
    expect(sparklineData.cpu[0]).toEqual({ timestamp: point.timestamp, value: 42.5 });
    expect(sparklineData.memory[0]).toEqual({ timestamp: point.timestamp, value: 30.1 });
    expect(sparklineData.blockRead[0]).toEqual({ timestamp: point.timestamp, value: 1024 });
    expect(sparklineData.blockWrite[0]).toEqual({ timestamp: point.timestamp, value: 2048 });
    expect(sparklineData.networkRx[0]).toEqual({ timestamp: point.timestamp, value: 512 });
    expect(sparklineData.networkTx[0]).toEqual({ timestamp: point.timestamp, value: 256 });
  });

  it('output arrays have the same length as input for multiple rows', () => {
    const rows = [
      makeRow({ time: Date.parse('2024-01-01T00:00:00.000Z'), cpu_percent: 10 }),
      makeRow({ time: Date.parse('2024-01-01T00:00:01.000Z'), cpu_percent: 20 }),
      makeRow({ time: Date.parse('2024-01-01T00:00:02.000Z'), cpu_percent: 30 }),
    ];

    const { dataPoints, sparklineData } = buildContainerChartData(rows);

    expect(dataPoints).toHaveLength(3);
    expect(sparklineData.cpu).toHaveLength(3);
    expect(sparklineData.memory).toHaveLength(3);
    expect(sparklineData.blockRead).toHaveLength(3);
    expect(sparklineData.blockWrite).toHaveLength(3);
    expect(sparklineData.networkRx).toHaveLength(3);
    expect(sparklineData.networkTx).toHaveLength(3);
  });

  it('preserves timestamps in insertion order for multiple rows', () => {
    const times = [
      Date.parse('2024-01-01T00:00:00.000Z'),
      Date.parse('2024-01-01T00:00:01.000Z'),
      Date.parse('2024-01-01T00:00:02.000Z'),
    ];
    const rows = times.map((time) => makeRow({ time }));

    const { dataPoints } = buildContainerChartData(rows);

    times.forEach((time, i) => {
      expect(dataPoints[i].timestamp).toBe(time);
    });
  });

  it('defaults null fields to 0', () => {
    const row = makeRow(); // all metric fields are null

    const { dataPoints, sparklineData } = buildContainerChartData([row]);

    const point = dataPoints[0];
    expect(point.cpuPercent).toBe(0);
    expect(point.memoryPercent).toBe(0);
    expect(point.blockIoReadBytesPerSec).toBe(0);
    expect(point.blockIoWriteBytesPerSec).toBe(0);
    expect(point.networkRxBytesPerSec).toBe(0);
    expect(point.networkTxBytesPerSec).toBe(0);

    expect(sparklineData.cpu[0].value).toBe(0);
    expect(sparklineData.memory[0].value).toBe(0);
    expect(sparklineData.blockRead[0].value).toBe(0);
    expect(sparklineData.blockWrite[0].value).toBe(0);
    expect(sparklineData.networkRx[0].value).toBe(0);
    expect(sparklineData.networkTx[0].value).toBe(0);
  });

  it('populates all 6 sparkline series independently', () => {
    const row = makeRow({
      cpu_percent: 1,
      memory_percent: 2,
      block_io_read_bytes_per_sec: 3,
      block_io_write_bytes_per_sec: 4,
      network_rx_bytes_per_sec: 5,
      network_tx_bytes_per_sec: 6,
    });

    const { sparklineData } = buildContainerChartData([row]);

    expect(sparklineData.cpu[0].value).toBe(1);
    expect(sparklineData.memory[0].value).toBe(2);
    expect(sparklineData.blockRead[0].value).toBe(3);
    expect(sparklineData.blockWrite[0].value).toBe(4);
    expect(sparklineData.networkRx[0].value).toBe(5);
    expect(sparklineData.networkTx[0].value).toBe(6);
  });
});

describe('useContainerChartData', () => {
  it('returns the same shape as buildContainerChartData for valid input', () => {
    const rows = [
      makeRow({
        time: Date.parse('2024-01-01T00:00:00.000Z'),
        cpu_percent: 50,
        memory_percent: 60,
        block_io_read_bytes_per_sec: 100,
        block_io_write_bytes_per_sec: 200,
        network_rx_bytes_per_sec: 300,
        network_tx_bytes_per_sec: 400,
      }),
    ];

    const { result } = renderHook(() => useContainerChartData(rows));
    const expected = buildContainerChartData(rows);

    expect(result.current.dataPoints).toEqual(expected.dataPoints);
    expect(result.current.sparklineData).toEqual(expected.sparklineData);
  });

  it('returns stable reference when the same array reference is passed on re-render', () => {
    const rows = [makeRow({ cpu_percent: 10 })];

    const { result, rerender } = renderHook(() => useContainerChartData(rows));

    const firstResult = result.current;
    rerender();

    expect(result.current).toBe(firstResult);
  });

  it('returns a new reference when the array reference changes', () => {
    let rows = [makeRow({ cpu_percent: 10 })];

    const { result, rerender } = renderHook(({ data }) => useContainerChartData(data), {
      initialProps: { data: rows },
    });

    const firstResult = result.current;

    rows = [makeRow({ cpu_percent: 20 })];
    rerender({ data: rows });

    expect(result.current).not.toBe(firstResult);
    expect(result.current.dataPoints[0].cpuPercent).toBe(20);
  });
});
