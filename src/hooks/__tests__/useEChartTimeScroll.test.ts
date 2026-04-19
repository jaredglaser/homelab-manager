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
  let originalIO: typeof IntersectionObserver | undefined;
  let ioCallbacks: IntersectionObserverCallback[];

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

    // Mock IntersectionObserver to immediately report "visible"
    ioCallbacks = [];
    originalIO = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class MockIO {
      constructor(cb: IntersectionObserverCallback) {
        ioCallbacks.push(cb);
      }
      observe(el: Element) {
        const cb = ioCallbacks.at(-1);
        if (cb) {
          cb(
            [{ isIntersecting: true, target: el } as unknown as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
        }
      }
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = '';
      thresholds: readonly number[] = [];
    } as unknown as typeof IntersectionObserver;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancelRaf;
    if (originalIO) globalThis.IntersectionObserver = originalIO;
  });

  function makeTargetRef() {
    return { current: document.createElement('div') };
  }

  it('should schedule a requestAnimationFrame on mount', () => {
    const mockSetOption = mock(() => {});
    const chartRef = {
      current: {
        getEchartsInstance: () => ({ setOption: mockSetOption }),
      },
    };

    renderHook(() => useEChartTimeScroll(chartRef as AnyRef, 60_000, makeTargetRef()));

    expect(rafCallbacks.length).toBeGreaterThanOrEqual(1);
  });

  it('should call setOption with xAxis min/max on each frame', () => {
    const mockSetOption = mock(() => {});
    const chartRef = {
      current: {
        getEchartsInstance: () => ({ setOption: mockSetOption }),
      },
    };

    renderHook(() => useEChartTimeScroll(chartRef as AnyRef, 60_000, makeTargetRef()));

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

    renderHook(() => useEChartTimeScroll(chartRef as AnyRef, 60_000, makeTargetRef()));

    // Trigger RAF - should not throw
    expect(() => rafCallbacks[0](performance.now())).not.toThrow();
  });

  it('should cancel animation frame on unmount', () => {
    const chartRef = { current: null };

    const { unmount } = renderHook(() =>
      useEChartTimeScroll(chartRef as AnyRef, 60_000, makeTargetRef()),
    );

    unmount();
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalled();
  });
});
