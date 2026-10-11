import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

const { renderHook, act } = await import('@testing-library/react');
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

  function makeInstance(setOption: (opt: unknown) => void, isDisposed = false) {
    return { setOption, isDisposed: () => isDisposed };
  }

  function markReady(result: { current: (instance: unknown) => void }, instance: unknown) {
    act(() => {
      result.current(instance);
    });
  }

  it('does not schedule rAF before the target becomes visible', () => {
    const mockSetOption = mock(() => {});
    const chartRef = {
      current: {
        getEchartsInstance: () => makeInstance(mockSetOption),
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
        getEchartsInstance: () => makeInstance(mockSetOption),
      },
    };
    const targetRef = makeTargetRef();

    renderHook(() => useEChartTimeScroll(chartRef as AnyRef, 60_000, targetRef));

    ioInstances[0].emit(targetRef.current, true);

    expect(rafCallbacks.length).toBeGreaterThanOrEqual(1);
  });

  it('skips setOption until onChartReady fires with the live instance', () => {
    // Regression: merging xAxis-only into echarts-for-react's bare temporary
    // instance throws in CartesianAxisView.render and kills the rAF loop.
    const mockSetOption = mock(() => {});
    const instance = makeInstance(mockSetOption);
    const chartRef = {
      current: {
        getEchartsInstance: () => instance,
      },
    };
    const targetRef = makeTargetRef();

    const { result } = renderHook(() => useEChartTimeScroll(chartRef as AnyRef, 60_000, targetRef));
    ioInstances[0].emit(targetRef.current, true);

    expect(() => rafCallbacks[0](performance.now())).not.toThrow();
    expect(mockSetOption).not.toHaveBeenCalled();

    markReady(result, instance);
    rafCallbacks[1](performance.now());

    expect(mockSetOption).toHaveBeenCalledTimes(1);
  });

  it('skips setOption when the live instance differs from the ready one', () => {
    // A remount or re-init puts a fresh bare instance on the element while the
    // hook still holds the previously-ready one; only the ready instance is driven.
    const readySetOption = mock(() => {});
    const bareSetOption = mock(() => {});
    const readyInstance = makeInstance(readySetOption);
    const bareInstance = makeInstance(bareSetOption);
    let live = bareInstance;
    const chartRef = {
      current: {
        getEchartsInstance: () => live,
      },
    };
    const targetRef = makeTargetRef();

    const { result } = renderHook(() => useEChartTimeScroll(chartRef as AnyRef, 60_000, targetRef));
    ioInstances[0].emit(targetRef.current, true);
    markReady(result, readyInstance);

    expect(() => rafCallbacks[0](performance.now())).not.toThrow();
    expect(bareSetOption).not.toHaveBeenCalled();

    live = readyInstance;
    rafCallbacks[1](performance.now());

    expect(readySetOption).toHaveBeenCalledTimes(1);
  });

  it('calls setOption with xAxis min/max on each frame once ready', () => {
    const mockSetOption = mock(() => {});
    const instance = makeInstance(mockSetOption);
    const chartRef = {
      current: {
        getEchartsInstance: () => instance,
      },
    };
    const targetRef = makeTargetRef();

    const { result } = renderHook(() => useEChartTimeScroll(chartRef as AnyRef, 60_000, targetRef));
    ioInstances[0].emit(targetRef.current, true);
    markReady(result, instance);

    const beforeCall = Date.now();
    rafCallbacks[0](performance.now());
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

    const { result } = renderHook(() => useEChartTimeScroll(chartRef as AnyRef, 60_000, targetRef));
    ioInstances[0].emit(targetRef.current, true);
    markReady(result, makeInstance(mock(() => {})));

    expect(() => rafCallbacks[0](performance.now())).not.toThrow();
  });

  it('skips setOption once the instance is disposed', () => {
    const mockSetOption = mock(() => {});
    const instance = makeInstance(mockSetOption, true);
    const chartRef = {
      current: {
        getEchartsInstance: () => instance,
      },
    };
    const targetRef = makeTargetRef();

    const { result } = renderHook(() => useEChartTimeScroll(chartRef as AnyRef, 60_000, targetRef));
    ioInstances[0].emit(targetRef.current, true);
    markReady(result, instance);

    expect(() => rafCallbacks[0](performance.now())).not.toThrow();
    expect(mockSetOption).not.toHaveBeenCalled();
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
