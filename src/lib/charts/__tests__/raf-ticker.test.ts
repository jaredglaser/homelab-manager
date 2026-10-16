import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

import { subscribeRafTicker } from '../raf-ticker';

describe('raf-ticker', () => {
  let rafCallbacks: ((time: number) => void)[];
  let originalRaf: typeof requestAnimationFrame;
  let originalCancelRaf: typeof cancelAnimationFrame;
  const activeUnsubs: Array<() => void> = [];

  beforeEach(() => {
    rafCallbacks = [];
    originalRaf = globalThis.requestAnimationFrame;
    originalCancelRaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb as (time: number) => void);
      return rafCallbacks.length;
    }) as unknown as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = mock(() => {}) as unknown as typeof cancelAnimationFrame;
  });

  afterEach(() => {
    while (activeUnsubs.length > 0) activeUnsubs.pop()!();
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancelRaf;
  });

  function track(unsub: () => void) {
    activeUnsubs.push(unsub);
    return unsub;
  }

  it('calls every subscriber with the same timestamp on a driven frame', () => {
    const a = mock((_t: number) => {});
    const b = mock((_t: number) => {});
    track(subscribeRafTicker(a));
    track(subscribeRafTicker(b));

    // A second subscribe must not queue a second rAF loop
    expect(rafCallbacks.length).toBe(1);

    rafCallbacks[0](1234);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0][0]).toBe(1234);
    expect(b.mock.calls[0][0]).toBe(1234);
  });

  it('keeps the loop alive across frames and stops after the last unsubscribe', () => {
    const cafSpy = globalThis.cancelAnimationFrame as unknown as ReturnType<typeof mock>;
    const unsub = track(subscribeRafTicker(() => {}));

    rafCallbacks[0](1000);
    expect(rafCallbacks.length).toBe(2);

    unsub();
    expect(cafSpy).toHaveBeenCalled();
  });

  it('drops to idle cadence when no subscriber reports busy', () => {
    const cb = mock(() => {});
    track(subscribeRafTicker(cb));

    rafCallbacks[0](1000);
    expect(cb).toHaveBeenCalledTimes(1);

    // Frame arriving 5ms later: inside the idle window, skipped but re-queued
    rafCallbacks[1](1005);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(rafCallbacks.length).toBe(3);

    // Frame arriving past the idle window: ticks again
    rafCallbacks[2](1150);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('holds full rate while any subscriber reports busy', () => {
    const idle = mock(() => {});
    const busy = mock(() => true);
    track(subscribeRafTicker(idle));
    track(subscribeRafTicker(busy));

    rafCallbacks[0](1000);
    rafCallbacks[1](1008);
    rafCallbacks[2](1016);

    expect(idle).toHaveBeenCalledTimes(3);
    expect(busy).toHaveBeenCalledTimes(3);
  });

  it('restarts immediately when a subscriber joins after a full stop', () => {
    const first = mock(() => {});
    const unsub = track(subscribeRafTicker(first));
    rafCallbacks[0](1000);
    unsub();
    rafCallbacks.length = 0;

    const second = mock(() => {});
    track(subscribeRafTicker(second));
    expect(rafCallbacks.length).toBe(1);

    rafCallbacks[0](5000);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stops the loop when the only subscriber unsubscribes during its own tick', () => {
    const cafSpy = globalThis.cancelAnimationFrame as unknown as ReturnType<typeof mock>;
    let unsub: () => void = () => {};
    const cb = mock(() => {
      unsub();
    });
    unsub = track(subscribeRafTicker(cb));

    rafCallbacks[0](1000);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cafSpy).toHaveBeenCalled();
    expect(rafCallbacks.length).toBe(1);
  });
});
