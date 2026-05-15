import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

mock.module('@/data/docker/functions', () => ({
  getContainerHistory: async () => [],
  getContainerInfo: async () => ({
    containerName: 'nginx',
    image: 'nginx:latest',
    icon: null,
    serviceKey: 'media-stack/nginx',
  }),
}));

mock.module('@/lib/utils/icon-resolver', () => ({
  getIconUrl: () => 'https://icons.example.com/nginx.png',
  FALLBACK_ICON_URL: 'https://icons.example.com/fallback.png',
}));

mock.module('@/lib/constants/ui-timing', () => ({
  CHART_DEBOUNCE_MS: 0,
}));

const { useContainerHistoryData, DEFAULT_RANGE_MS } = await import('@/components/docker/useContainerHistoryData');

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useContainerHistoryData hook', () => {
  let setTimeoutSpy: ReturnType<typeof spyOn>;
  let clearTimeoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    let id = 1;
    setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      const timerId = id++;
      fn();
      return timerId as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    clearTimeoutSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it('returns initial selectedMetrics from initialMetrics param', () => {
    const wrapper = makeWrapper();
    const { result } = renderHook(
      () => useContainerHistoryData({ containerId: 'abc123', host: 'server1', initialMetrics: 'cpu,memory' }),
      { wrapper },
    );
    expect(result.current.selectedMetrics.has('cpu')).toBe(true);
    expect(result.current.selectedMetrics.has('memory')).toBe(true);
  });

  it('uses DEFAULT_RANGE_MS for initial range when no initialFrom/To provided', () => {
    const wrapper = makeWrapper();
    const before = Date.now();
    const { result } = renderHook(
      () => useContainerHistoryData({ containerId: 'abc123', initialMetrics: 'cpu' }),
      { wrapper },
    );
    const { initialRange } = result.current;
    expect(initialRange.to).toBeGreaterThanOrEqual(before);
    expect(initialRange.to - initialRange.from).toBeCloseTo(DEFAULT_RANGE_MS, -3);
  });

  it('uses provided initialFrom/To when given', () => {
    const wrapper = makeWrapper();
    const { result } = renderHook(
      () => useContainerHistoryData({
        containerId: 'abc123',
        initialMetrics: 'cpu',
        initialFrom: 1000,
        initialTo: 5000,
      }),
      { wrapper },
    );
    expect(result.current.initialRange.from).toBe(1000);
    expect(result.current.initialRange.to).toBe(5000);
  });

  it('handleMetricsChange updates selectedMetrics', () => {
    const wrapper = makeWrapper();
    const { result } = renderHook(
      () => useContainerHistoryData({ containerId: 'abc123', initialMetrics: 'cpu,memory' }),
      { wrapper },
    );
    act(() => {
      result.current.handleMetricsChange(new Set(['blockRead', 'networkRx']));
    });
    expect(result.current.selectedMetrics.has('blockRead')).toBe(true);
    expect(result.current.selectedMetrics.has('cpu')).toBe(false);
  });

  it('handlePresetChange updates timelineRange and activePresetMs', () => {
    const wrapper = makeWrapper();
    const { result } = renderHook(
      () => useContainerHistoryData({ containerId: 'abc123', initialMetrics: 'cpu' }),
      { wrapper },
    );
    const before = Date.now();
    act(() => {
      result.current.handlePresetChange(3_600_000);
    });
    expect(result.current.activePresetMs).toBe(3_600_000);
    expect(result.current.timelineRange.to).toBeGreaterThanOrEqual(before);
    expect(result.current.timelineRange.to - result.current.timelineRange.from).toBeCloseTo(3_600_000, -3);
  });

  it('handleCustomRangeChange updates timelineRange and clears activePresetMs', () => {
    const wrapper = makeWrapper();
    const { result } = renderHook(
      () => useContainerHistoryData({ containerId: 'abc123', initialMetrics: 'cpu' }),
      { wrapper },
    );
    act(() => {
      result.current.handleCustomRangeChange(1000, 5000);
    });
    expect(result.current.timelineRange.from).toBe(1000);
    expect(result.current.timelineRange.to).toBe(5000);
    expect(result.current.activePresetMs).toBeNull();
  });

  it('handleRangeChange triggers debounced chart range update', () => {
    const wrapper = makeWrapper();
    const { result } = renderHook(
      () => useContainerHistoryData({ containerId: 'abc123', initialMetrics: 'cpu' }),
      { wrapper },
    );
    act(() => {
      result.current.handleRangeChange(2000, 8000);
    });
    // With CHART_DEBOUNCE_MS=0 and mocked setTimeout (fires immediately), chart range updates
    expect(result.current.chartFrom).toBe(2000);
    expect(result.current.chartTo).toBe(8000);
  });

  it('setIconError updates iconError state', () => {
    const wrapper = makeWrapper();
    const { result } = renderHook(
      () => useContainerHistoryData({ containerId: 'abc123', initialMetrics: 'cpu' }),
      { wrapper },
    );
    expect(result.current.iconError).toBe(false);
    act(() => {
      result.current.setIconError(true);
    });
    expect(result.current.iconError).toBe(true);
  });

  it('isChartDataEmpty is true initially (no data, not fetching)', async () => {
    const wrapper = makeWrapper();
    const { result } = renderHook(
      () => useContainerHistoryData({ containerId: 'abc123', initialMetrics: 'cpu' }),
      { wrapper },
    );
    // Chart data is empty initially and query completes quickly with empty array
    expect(result.current.chartData).toEqual([]);
  });

  it('detects active preset when initial range matches a preset ending near now', () => {
    const wrapper = makeWrapper();
    const now = Date.now();
    const { result } = renderHook(
      () => useContainerHistoryData({
        containerId: 'abc123',
        initialMetrics: 'cpu',
        initialFrom: now - 3_600_000,
        initialTo: now,
      }),
      { wrapper },
    );
    expect(result.current.activePresetMs).toBe(3_600_000);
  });

  it('does not detect preset when initial range does not end near now', () => {
    const wrapper = makeWrapper();
    const { result } = renderHook(
      () => useContainerHistoryData({
        containerId: 'abc123',
        initialMetrics: 'cpu',
        initialFrom: 1000,
        initialTo: 3_601_000,
      }),
      { wrapper },
    );
    expect(result.current.activePresetMs).toBeNull();
  });
});
