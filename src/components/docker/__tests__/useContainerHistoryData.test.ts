import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { ReactNode } from 'react';
import type { DockerStatsRow } from '@/types/docker';
import type { MetricType } from '@/components/docker/MetricCheckboxes';

/** Minimal valid DockerStatsRow with all nullable fields null */
function makeRow(overrides: Partial<DockerStatsRow> = {}): DockerStatsRow {
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

const SAMPLE_ROWS: DockerStatsRow[] = [makeRow({ cpu_percent: 12.5, memory_percent: 40 })];

const getContainerHistory = mock(async () => SAMPLE_ROWS);

mock.module('@/data/docker/functions', () => ({
  getContainerHistory,
}));

const { useContainerHistoryData, parseMetrics, DEFAULT_RANGE_MS } = await import(
  '@/components/docker/useContainerHistoryData'
);
const { renderHook, act, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createElement } = await import('react');

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

const HOUR_MS = 3_600_000;

beforeEach(() => {
  getContainerHistory.mockClear();
});

describe('parseMetrics', () => {
  it('parses a valid comma-separated string into the matching set', () => {
    const result = parseMetrics('cpu,networkRx,blockWrite');

    expect(result).toEqual(new Set<MetricType>(['cpu', 'networkRx', 'blockWrite']));
  });

  it('defaults to {cpu, memory} on an empty string', () => {
    expect(parseMetrics('')).toEqual(new Set<MetricType>(['cpu', 'memory']));
  });

  it('defaults to {cpu, memory} when no token is recognized', () => {
    expect(parseMetrics('foo,bar,baz')).toEqual(new Set<MetricType>(['cpu', 'memory']));
  });

  it('filters out invalid tokens while keeping valid ones', () => {
    const result = parseMetrics('cpu,bogus,memory');

    expect(result).toEqual(new Set<MetricType>(['cpu', 'memory']));
  });

  it('dedupes repeated tokens via the returned Set', () => {
    const result = parseMetrics('cpu,cpu,memory,memory');

    expect(result.size).toBe(2);
    expect(result).toEqual(new Set<MetricType>(['cpu', 'memory']));
  });
});

describe('useContainerHistoryData', () => {
  it('returns initial range and selected metrics and triggers a history fetch', async () => {
    const { result } = renderHook(
      () => useContainerHistoryData({ containerId: 'abc123', host: 'testhost', initialMetrics: 'cpu,memory' }),
      { wrapper: makeWrapper() },
    );

    expect(result.current.selectedMetrics).toEqual(new Set<MetricType>(['cpu', 'memory']));
    expect(result.current.initialRange.to - result.current.initialRange.from).toBe(DEFAULT_RANGE_MS);
    expect(result.current.timelineRange).toEqual(result.current.initialRange);

    await waitFor(() => {
      expect(getContainerHistory).toHaveBeenCalled();
    });
  });

  it('handlePresetChange sets activePresetMs and updates the timeline range', () => {
    const { result } = renderHook(
      () => useContainerHistoryData({ containerId: 'abc123', initialMetrics: 'cpu' }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.handlePresetChange(HOUR_MS);
    });

    expect(result.current.activePresetMs).toBe(HOUR_MS);
    expect(result.current.timelineRange.to - result.current.timelineRange.from).toBe(HOUR_MS);
    expect(result.current.chartTo - result.current.chartFrom).toBe(HOUR_MS);
  });

  it('handleCustomRangeChange clears activePresetMs and sets the supplied range', () => {
    const { result } = renderHook(
      () => useContainerHistoryData({ containerId: 'abc123', initialMetrics: 'cpu' }),
      { wrapper: makeWrapper() },
    );

    // Start from an active preset so we can observe it being cleared.
    act(() => {
      result.current.handlePresetChange(HOUR_MS);
    });
    expect(result.current.activePresetMs).toBe(HOUR_MS);

    const from = 1_000_000;
    const to = 2_000_000;
    act(() => {
      result.current.handleCustomRangeChange(from, to);
    });

    expect(result.current.activePresetMs).toBeNull();
    expect(result.current.timelineRange).toEqual({ from, to });
    expect(result.current.chartFrom).toBe(from);
    expect(result.current.chartTo).toBe(to);
  });

  it('handleRangeChange debounces the chart range update', () => {
    // Make the debounce timer fire synchronously so debouncedRange updates within act().
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    try {
      const { result } = renderHook(
        () => useContainerHistoryData({ containerId: 'abc123', initialMetrics: 'cpu' }),
        { wrapper: makeWrapper() },
      );

      const from = 500_000;
      const to = 900_000;
      act(() => {
        result.current.handleRangeChange(from, to);
      });

      expect(result.current.chartFrom).toBe(from);
      expect(result.current.chartTo).toBe(to);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('handleMetricsChange replaces the selected metrics', () => {
    const { result } = renderHook(
      () => useContainerHistoryData({ containerId: 'abc123', initialMetrics: 'cpu' }),
      { wrapper: makeWrapper() },
    );

    const next = new Set<MetricType>(['networkRx', 'networkTx']);
    act(() => {
      result.current.handleMetricsChange(next);
    });

    expect(result.current.selectedMetrics).toEqual(next);
  });

  it('reports isChartDataEmpty once the empty result settles and fetching stops', async () => {
    // Both the timeline and chart queries call getContainerHistory, so return
    // empty for every call during this test rather than a single invocation.
    getContainerHistory.mockImplementation(async () => []);

    try {
      const { result } = renderHook(
        () => useContainerHistoryData({ containerId: 'empty', initialMetrics: 'cpu' }),
        { wrapper: makeWrapper() },
      );

      await waitFor(() => {
        expect(result.current.isChartDataEmpty).toBe(true);
      });
      expect(result.current.chartData).toEqual([]);
    } finally {
      getContainerHistory.mockImplementation(async () => SAMPLE_ROWS);
    }
  });

  it('exposes fetched rows as chartData and timelineData', async () => {
    const { result } = renderHook(
      () => useContainerHistoryData({ containerId: 'abc123', initialMetrics: 'cpu' }),
      { wrapper: makeWrapper() },
    );

    await waitFor(() => {
      expect(result.current.chartData).toEqual(SAMPLE_ROWS);
    });
    expect(result.current.timelineData).toEqual(SAMPLE_ROWS);
    expect(result.current.isChartDataEmpty).toBe(false);
  });

  describe('activePresetMs initialization', () => {
    it('matches a preset when the range ends near now with a preset-sized span', () => {
      const now = Date.now();
      const { result } = renderHook(
        () =>
          useContainerHistoryData({
            containerId: 'abc123',
            initialMetrics: 'cpu',
            initialFrom: now - HOUR_MS,
            initialTo: now,
          }),
        { wrapper: makeWrapper() },
      );

      expect(result.current.activePresetMs).toBe(HOUR_MS);
    });

    it('stays null for a historical custom range with a preset-sized span', () => {
      // Same 1h span but anchored far in the past, so it must not match a preset.
      const historicalTo = Date.now() - 10 * 24 * HOUR_MS;
      const { result } = renderHook(
        () =>
          useContainerHistoryData({
            containerId: 'abc123',
            initialMetrics: 'cpu',
            initialFrom: historicalTo - HOUR_MS,
            initialTo: historicalTo,
          }),
        { wrapper: makeWrapper() },
      );

      expect(result.current.activePresetMs).toBeNull();
    });
  });
});

afterEach(() => {
  mock.restore();
});
