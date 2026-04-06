import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

const { renderHook } = await import('@testing-library/react');
const { useEChartTimeScroll } = await import('../useEChartTimeScroll');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRef = any;

describe('useEChartTimeScroll', () => {
  let rafCallbacks: ((time: number) => void)[];
  let rafIdCounter: number;
  let originalRaf: typeof requestAnimationFrame;
  let originalCancelRaf: typeof cancelAnimationFrame;

  beforeEach(() => {
    rafCallbacks = [];
    rafIdCounter = 0;
    originalRaf = globalThis.requestAnimationFrame;
    originalCancelRaf = globalThis.cancelAnimationFrame;

    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      const id = ++rafIdCounter;
      rafCallbacks.push(cb as (time: number) => void);
      return id;
    };
    globalThis.cancelAnimationFrame = mock(() => {});
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancelRaf;
  });

  it('should schedule a requestAnimationFrame on mount', () => {
    const mockSetOption = mock(() => {});
    const chartRef = {
      current: {
        getEchartsInstance: () => ({ setOption: mockSetOption }),
      },
    };

    renderHook(() => useEChartTimeScroll(chartRef as AnyRef, 60_000));

    expect(rafCallbacks.length).toBeGreaterThanOrEqual(1);
  });

  it('should call setOption with xAxis min/max on each frame', () => {
    const mockSetOption = mock(() => {});
    const chartRef = {
      current: {
        getEchartsInstance: () => ({ setOption: mockSetOption }),
      },
    };

    renderHook(() => useEChartTimeScroll(chartRef as AnyRef, 60_000));

    // Trigger the first RAF callback
    const cb = rafCallbacks[0];
    const beforeCall = Date.now();
    cb(performance.now());
    const afterCall = Date.now();

    expect(mockSetOption).toHaveBeenCalledTimes(1);
    const args = mockSetOption.mock.calls[0] as unknown as [{ xAxis: { min: number; max: number } }];
    const call = args[0];
    expect(call.xAxis.max).toBeGreaterThanOrEqual(beforeCall);
    expect(call.xAxis.max).toBeLessThanOrEqual(afterCall);
    expect(call.xAxis.min).toBeGreaterThanOrEqual(beforeCall - 60_000);
    expect(call.xAxis.min).toBeLessThanOrEqual(afterCall - 60_000);
  });

  it('should not throw when chartRef.current is null', () => {
    const chartRef = { current: null };

    renderHook(() => useEChartTimeScroll(chartRef as AnyRef, 60_000));

    // Trigger RAF - should not throw
    expect(() => rafCallbacks[0](performance.now())).not.toThrow();
  });

  it('should cancel animation frame on unmount', () => {
    const chartRef = { current: null };

    const { unmount } = renderHook(() => useEChartTimeScroll(chartRef as AnyRef, 60_000));

    unmount();
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalled();
  });
});
