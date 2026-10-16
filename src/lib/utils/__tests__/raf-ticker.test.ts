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

  it('keeps the loop alive when one of two subscribers unsubscribes mid-loop', () => {
    const cafSpy = globalThis.cancelAnimationFrame as unknown as ReturnType<typeof mock>;
    const a = mock((_t: number) => {});
    const b = mock((_t: number) => {});
    const unsubA = track(subscribeRafTicker(a));
    track(subscribeRafTicker(b));

    rafCallbacks[0](1000);
    unsubA();

    // Drive the requeued frames: b keeps ticking, the loop is not cancelled.
    rafCallbacks[1](1200);
    rafCallbacks[2](1400);
    expect(b).toHaveBeenCalledTimes(3);
    expect(a).toHaveBeenCalledTimes(1);
    expect(cafSpy).not.toHaveBeenCalled();
  });

  it('a throwing subscriber stops the loop for everyone and a fresh subscribe restarts it', () => {
    const errSpy = mock(() => {});
    const originalErr = console.error;
    console.error = errSpy as unknown as typeof console.error;
    try {
      const innocent = mock((_t: number) => {});
      const thrower = mock((_t: number) => {
        throw new Error('boom');
      });
      track(subscribeRafTicker(innocent));
      const unsubThrower = track(subscribeRafTicker(thrower));

      rafCallbacks[0](1000);

      // The innocent subscriber got its tick, then the thrower killed the loop.
      expect(innocent).toHaveBeenCalledTimes(1);
      expect(errSpy).toHaveBeenCalled();
      // Death leaves nothing pending (no orphaned requeue) and the loop dead.
      expect(rafCallbacks.length).toBe(1);
      expect(globalThis.cancelAnimationFrame as unknown as ReturnType<typeof mock>).not.toHaveBeenCalled();

      // The thrower stays subscribed, so the owner removes it, then a fresh
      // subscription restarts with exactly one rAF callback.
      unsubThrower();
      const revived = mock((_t: number) => {});
      track(subscribeRafTicker(revived));
      expect(rafCallbacks.length).toBe(2);
      rafCallbacks[1](5000);
      expect(revived).toHaveBeenCalledTimes(1);
    } finally {
      console.error = originalErr;
    }
  });

  it('does not double-schedule when a subscriber unsubscribes and a new one joins in the same tick', () => {
    let unsubA: () => void = () => {};
    let unsubReplacement: (() => void) | null = null;
    let replacementCalls = 0;
    const replacement = mock((_t: number) => {
      replacementCalls += 1;
    });
    const a = mock((_t: number) => {
      unsubA();
      unsubReplacement = subscribeRafTicker(replacement);
    });
    unsubA = track(subscribeRafTicker(a));

    rafCallbacks[0](1000);

    // Exactly one new chain pending (the replacement), not a second re-queue.
    expect(rafCallbacks.length).toBe(2);
    // Set iteration visits a subscriber added mid-tick in the same frame.
    expect(replacementCalls).toBe(1);

    rafCallbacks[1](1200);
    expect(replacementCalls).toBe(2);
    // The surviving single chain requeued exactly one more frame.
    expect(rafCallbacks.length).toBe(3);
    if (unsubReplacement) track(unsubReplacement);
  });

  it('cancels a foreign chain when a mid-tick resubscriber throws', () => {
    const errSpy = mock(() => {});
    const originalErr = console.error;
    console.error = errSpy as unknown as typeof console.error;
    try {
      const cafSpy = globalThis.cancelAnimationFrame as unknown as ReturnType<typeof mock>;
      let unsubA: () => void = () => {};
      let replacementCalls = 0;
      const replacement = mock((_t: number) => {
        replacementCalls += 1;
      });
      let unsubReplacement: (() => void) | null = null;
      const a = mock((_t: number) => {
        unsubA();
        unsubReplacement = subscribeRafTicker(replacement);
        track(unsubReplacement);
        throw new Error('boom');
      });
      unsubA = track(subscribeRafTicker(a));

      rafCallbacks[0](1000);

      // The throw aborted iteration before the replacement was visited, and
      // the death path cancelled the foreign chain the resubscribe queued.
      expect(replacementCalls).toBe(0);
      expect(cafSpy).toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalled();

      // State is clean: a fresh subscribe queues exactly one frame, and the
      // still-subscribed replacement ticks on it.
      const revived = mock((_t: number) => {});
      const before = rafCallbacks.length;
      track(subscribeRafTicker(revived));
      expect(rafCallbacks.length).toBe(before + 1);
      rafCallbacks[before](2000);
      expect(replacementCalls).toBe(1);
      expect(revived).toHaveBeenCalledTimes(1);
    } finally {
      console.error = originalErr;
    }
  });

  it('a fresh subscribe while the thrower is still subscribed restarts only to die again', () => {
    const errSpy = mock(() => {});
    const originalErr = console.error;
    console.error = errSpy as unknown as typeof console.error;
    try {
      const thrower = mock((_t: number) => {
        throw new Error('boom');
      });
      const unsubThrower = track(subscribeRafTicker(thrower));

      rafCallbacks[0](1000);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(rafCallbacks.length).toBe(1);

      const revived = mock((_t: number) => {});
      track(subscribeRafTicker(revived));
      rafCallbacks[1](2000);

      // The thrower throws again: revived is never ticked, nothing pending.
      expect(revived).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledTimes(2);
      expect(rafCallbacks.length).toBe(2);

      // Removing the thrower self-heals and re-arms the loop for the survivor.
      unsubThrower();
      rafCallbacks[2](3000);
      expect(revived).toHaveBeenCalledTimes(1);
    } finally {
      console.error = originalErr;
    }
  });
});