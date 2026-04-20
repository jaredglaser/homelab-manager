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

  // Captured IO instances so each test drives visibility explicitly via emit().
  // observe() does NOT auto-emit; tests must call emit(target, true) to start the gated rAF loop.
  let ioInstances: Array<{
    cb: IntersectionObserverCallback;
    observed: Element[];
    emit: (target: Element, isIntersecting: boolean) => void;
  }>;

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

    ioInstances = [];
    originalIO = globalThis.IntersectionObserver;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const MockIO: any = class {
      cb: IntersectionObserverCallback;
      observed: Element[] = [];
      root = null;
      rootMargin = '';
      thresholds: readonly number[] = [];

      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
        const self = this;
        ioInstances.push({
          cb: this.cb,
          observed: this.observed,
          emit: (target: Element, isIntersecting: boolean) => {
            self.cb(
              [{ isIntersecting, target } as unknown as IntersectionObserverEntry],
              self as unknown as IntersectionObserver,
            );
          },
        });
      }
      observe(el: Element) {
        this.observed.push(el);
      }
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    };
    globalThis.IntersectionObserver = MockIO as unknown as typeof IntersectionObserver;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancelRaf;
    if (originalIO) globalThis.IntersectionObserver = originalIO;
  });

  function makeTargetRef() {
    return { current: document.createElement('div') };
  }

  it('does not schedule rAF before the target becomes visible', () => {
    const mockSetOption = mock(() => {});
    const chartRef = {
      current: {
        getEchartsInstance: () => ({ setOption: mockSetOption }),
      },
    };

    renderHook(() => useEChartTimeScroll(chartRef as AnyRef, 60_000, makeTargetRef()));

    // Observer is created but no rAF is queued until visibility is reported true
    expect(ioInstances.length).toBe(1);
    expect(rafCallbacks.length).toBe(0);
    expect(mockSetOption).not.toHaveBeenCalled();
  });

  it('starts scheduling rAF once the target becomes visible', () => {
    const mockSetOption = mock(() => {});
    const chartRef = {
      current: {
        getEchartsInstance: () => ({ setOption: mockSetOption }),
      },
    };
    const targetRef = makeTargetRef();

    renderHook(() => useEChartTimeScroll(chartRef as AnyRef, 60_000, targetRef));

    ioInstances[0].emit(targetRef.current, true);

    expect(rafCallbacks.length).toBeGreaterThanOrEqual(1);
  });

  it('calls setOption with xAxis min/max on each frame', () => {
    const mockSetOption = mock(() => {});
    const chartRef = {
      current: {
        getEchartsInstance: () => ({ setOption: mockSetOption }),
      },
    };
    const targetRef = makeTargetRef();

    renderHook(() => useEChartTimeScroll(chartRef as AnyRef, 60_000, targetRef));
    ioInstances[0].emit(targetRef.current, true);

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

  it('does not throw when chartRef.current is null', () => {
    const chartRef = { current: null };
    const targetRef = makeTargetRef();

    renderHook(() => useEChartTimeScroll(chartRef as AnyRef, 60_000, targetRef));
    ioInstances[0].emit(targetRef.current, true);

    expect(() => rafCallbacks[0](performance.now())).not.toThrow();
  });

  it('cancels animation frame on unmount', () => {
    const chartRef = { current: null };
    const targetRef = makeTargetRef();

    const { unmount } = renderHook(() =>
      useEChartTimeScroll(chartRef as AnyRef, 60_000, targetRef),
    );
    ioInstances[0].emit(targetRef.current, true);

    unmount();
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalled();
  });
});
