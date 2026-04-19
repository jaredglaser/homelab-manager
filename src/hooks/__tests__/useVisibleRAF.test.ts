import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

const { renderHook } = await import('@testing-library/react');
const { useVisibleRAF } = await import('../useVisibleRAF');

describe('useVisibleRAF', () => {
  let rafCallbacks: ((time: number) => void)[];
  let rafIdCounter: number;
  let originalRaf: typeof requestAnimationFrame;
  let originalCancelRaf: typeof cancelAnimationFrame;
  let originalIO: typeof IntersectionObserver | undefined;

  // Captured IntersectionObserver instances so the test can drive visibility changes
  let ioInstances: Array<{
    cb: IntersectionObserverCallback;
    observed: Element[];
    disconnect: ReturnType<typeof mock>;
    // Helper to emit an intersection event
    emit: (target: Element, isIntersecting: boolean) => void;
  }>;

  beforeEach(() => {
    rafCallbacks = [];
    rafIdCounter = 0;
    originalRaf = globalThis.requestAnimationFrame;
    originalCancelRaf = globalThis.cancelAnimationFrame;

    globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => {
      const id = ++rafIdCounter;
      rafCallbacks.push(cb as (time: number) => void);
      return id;
    }) as unknown as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = mock(() => {}) as unknown as typeof cancelAnimationFrame;

    ioInstances = [];
    originalIO = globalThis.IntersectionObserver;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const MockIO: any = class {
      cb: IntersectionObserverCallback;
      observed: Element[] = [];
      disconnect = mock(() => {});
      root = null;
      rootMargin = '';
      thresholds: readonly number[] = [];

      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
        const self = this;
        ioInstances.push({
          cb: this.cb,
          observed: this.observed,
          disconnect: this.disconnect,
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

  it('runs rAF when IntersectionObserver reports isIntersecting: true', () => {
    const cb = mock(() => {});
    const targetRef = makeTargetRef();

    renderHook(() => useVisibleRAF(targetRef, cb));

    expect(ioInstances.length).toBe(1);
    expect(rafCallbacks.length).toBe(0);

    // Fire "visible"
    ioInstances[0].emit(targetRef.current, true);

    expect(rafCallbacks.length).toBe(1);

    // Invoke the frame callback — user callback should be called
    rafCallbacks[0](performance.now());
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('cancels rAF when IntersectionObserver reports isIntersecting: false', () => {
    const cb = mock(() => {});
    const targetRef = makeTargetRef();

    renderHook(() => useVisibleRAF(targetRef, cb));

    const ioInstance = ioInstances[0];

    // Visible → rAF queued
    ioInstance.emit(targetRef.current, true);
    expect(rafCallbacks.length).toBe(1);

    const cafSpy = globalThis.cancelAnimationFrame as unknown as ReturnType<typeof mock>;
    const callsBefore = cafSpy.mock.calls.length;

    // Invisible → cancel
    ioInstance.emit(targetRef.current, false);
    expect(cafSpy.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('resumes rAF when transitioning false → true', () => {
    const cb = mock(() => {});
    const targetRef = makeTargetRef();

    renderHook(() => useVisibleRAF(targetRef, cb));

    const ioInstance = ioInstances[0];

    ioInstance.emit(targetRef.current, true);
    ioInstance.emit(targetRef.current, false);

    const rafCountBefore = rafCallbacks.length;

    ioInstance.emit(targetRef.current, true);
    expect(rafCallbacks.length).toBeGreaterThan(rafCountBefore);
  });

  it('re-scheduling itself continues the loop while visible', () => {
    const cb = mock(() => {});
    const targetRef = makeTargetRef();

    renderHook(() => useVisibleRAF(targetRef, cb));

    ioInstances[0].emit(targetRef.current, true);

    // Drive 3 frames
    for (let i = 0; i < 3; i++) {
      const frame = rafCallbacks.shift();
      if (frame) frame(performance.now());
    }

    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('disconnects observer and cancels rAF on unmount', () => {
    const cb = mock(() => {});
    const targetRef = makeTargetRef();

    const { unmount } = renderHook(() => useVisibleRAF(targetRef, cb));

    // Make it visible so there is a pending rAF to cancel
    ioInstances[0].emit(targetRef.current, true);

    const cafSpy = globalThis.cancelAnimationFrame as unknown as ReturnType<typeof mock>;
    const cafBefore = cafSpy.mock.calls.length;

    unmount();

    expect(ioInstances[0].disconnect).toHaveBeenCalled();
    expect(cafSpy.mock.calls.length).toBeGreaterThan(cafBefore);
  });

  it('uses latest callback without re-subscribing (stale-closure free)', () => {
    const cb1 = mock(() => {});
    const cb2 = mock(() => {});
    const targetRef = makeTargetRef();

    const { rerender } = renderHook(
      ({ fn }: { fn: (ts: number) => void }) => useVisibleRAF(targetRef, fn),
      { initialProps: { fn: cb1 } },
    );

    ioInstances[0].emit(targetRef.current, true);

    // Rerender with a new callback — should NOT create a new observer
    rerender({ fn: cb2 });

    expect(ioInstances.length).toBe(1);

    // Fire a frame; cb2 should be invoked, not cb1
    rafCallbacks[0](performance.now());
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb1).not.toHaveBeenCalled();
  });

  it('no-ops (no observer) when targetRef.current is null', () => {
    const cb = mock(() => {});
    const targetRef = { current: null };

    renderHook(() => useVisibleRAF(targetRef, cb));

    expect(ioInstances.length).toBe(0);
    expect(rafCallbacks.length).toBe(0);
  });

  it('falls back to unconditional rAF when IntersectionObserver is unavailable', () => {
    const originalIoInner = globalThis.IntersectionObserver;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).IntersectionObserver = undefined;

    try {
      const cb = mock(() => {});
      const targetRef = makeTargetRef();

      renderHook(() => useVisibleRAF(targetRef, cb));

      // rAF scheduled immediately without any IO events
      expect(rafCallbacks.length).toBe(1);

      rafCallbacks[0](performance.now());
      expect(cb).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.IntersectionObserver = originalIoInner;
    }
  });
});
