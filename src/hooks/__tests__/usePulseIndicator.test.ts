import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

const { renderHook, act } = await import('@testing-library/react');
const { usePulseIndicator } = await import('../usePulseIndicator');

const PULSE_DURATION_MS = 1000;
const LATE_THRESHOLD_MS = 2000;

function makeDiv(): HTMLDivElement {
  return document.createElement('div');
}

describe('usePulseIndicator', () => {
  describe('return value', () => {
    it('returns three refs that are initially null', () => {
      const { result } = renderHook(() => usePulseIndicator(0));
      expect(result.current.indicatorRef).toBeDefined();
      expect(result.current.pingRef).toBeDefined();
      expect(result.current.dotRef).toBeDefined();
      expect(result.current.indicatorRef.current).toBeNull();
      expect(result.current.pingRef.current).toBeNull();
      expect(result.current.dotRef.current).toBeNull();
    });
  });

  describe('when lastUpdatedMs is 0 on mount', () => {
    it('does not mutate DOM elements attached to refs', () => {
      const { result } = renderHook(() => usePulseIndicator(0));

      const indicator = makeDiv();
      const ping = makeDiv();
      const dot = makeDiv();

      // Manually attach divs after initial render
      Object.defineProperty(result.current.indicatorRef, 'current', { value: indicator, writable: true });
      Object.defineProperty(result.current.pingRef, 'current', { value: ping, writable: true });
      Object.defineProperty(result.current.dotRef, 'current', { value: dot, writable: true });

      // Re-render with 0 - should not trigger effect
      act(() => {
        // nothing changed
      });

      expect(indicator.title).toBe('');
      expect(ping.style.backgroundColor).toBe('');
      expect(dot.style.backgroundColor).toBe('');
      expect(ping.classList.contains('opacity-100')).toBe(false);
      expect(ping.classList.contains('animate-ping')).toBe(false);
    });
  });

  describe('timer behavior', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let timerCallbacks: Map<any, { fn: () => void; delay: number }>;
    let originalSetTimeout: typeof globalThis.setTimeout;
    let originalClearTimeout: typeof globalThis.clearTimeout;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let clearedTimers: Set<any>;
    let timerIdCounter: number;

    beforeEach(() => {
      timerCallbacks = new Map();
      clearedTimers = new Set();
      timerIdCounter = 100;
      originalSetTimeout = globalThis.setTimeout;
      originalClearTimeout = globalThis.clearTimeout;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).setTimeout = (fn: () => void, delay: number) => {
        const id = ++timerIdCounter;
        timerCallbacks.set(id, { fn, delay });
        return id;
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).clearTimeout = (id: any) => {
        clearedTimers.add(id);
      };
    });

    afterEach(() => {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    });

    it('triggers animation classes and styles on a new non-zero timestamp', () => {
      const { result, rerender } = renderHook(({ ts }) => usePulseIndicator(ts), {
        initialProps: { ts: 0 },
      });

      const indicator = makeDiv();
      const ping = makeDiv();
      const dot = makeDiv();
      ping.classList.add('opacity-0');

      // Attach divs to the refs
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result.current.indicatorRef as any).current = indicator;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result.current.pingRef as any).current = ping;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result.current.dotRef as any).current = dot;

      const ts = 1700000000000;
      act(() => {
        rerender({ ts });
      });

      expect(ping.classList.contains('opacity-100')).toBe(true);
      expect(ping.classList.contains('animate-ping')).toBe(true);
      expect(ping.classList.contains('opacity-0')).toBe(false);
      expect(ping.style.backgroundColor).toBe('var(--indicator-active)');
      expect(dot.style.backgroundColor).toBe('var(--indicator-active)');
      expect(indicator.title).toContain('Last updated:');
    });

    it('does not re-trigger animation when re-rendered with same timestamp', () => {
      const { result, rerender } = renderHook(({ val }) => usePulseIndicator(val), {
        initialProps: { val: 0 },
      });

      const ping = makeDiv();
      const dot = makeDiv();
      ping.classList.add('opacity-0');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result.current.pingRef as any).current = ping;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result.current.dotRef as any).current = dot;

      // First trigger: new timestamp fires the animation
      const ts = 1700000000000;
      act(() => { rerender({ val: ts }); });
      expect(ping.classList.contains('opacity-100')).toBe(true);

      // Reset captured timer state from the first trigger
      timerCallbacks.clear();

      // Second render with the SAME timestamp: must be a no-op
      act(() => { rerender({ val: ts }); });

      expect(timerCallbacks.size).toBe(0);
      // classList must not have been reset mid-animation
      expect(ping.classList.contains('opacity-100')).toBe(true);
    });

    it('reverts ping classes after PULSE_DURATION_MS timer fires', () => {
      const { result, rerender } = renderHook(({ ts }) => usePulseIndicator(ts), {
        initialProps: { ts: 0 },
      });

      const ping = makeDiv();
      ping.classList.add('opacity-0');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result.current.pingRef as any).current = ping;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result.current.dotRef as any).current = makeDiv();

      act(() => {
        rerender({ ts: 1700000001000 });
      });

      // Find the pulse timer (delay === PULSE_DURATION_MS)
      const pulseEntry = [...timerCallbacks.entries()].find(([, v]) => v.delay === PULSE_DURATION_MS);
      expect(pulseEntry).toBeDefined();

      act(() => {
        pulseEntry![1].fn();
      });

      expect(ping.classList.contains('opacity-100')).toBe(false);
      expect(ping.classList.contains('animate-ping')).toBe(false);
      expect(ping.classList.contains('opacity-0')).toBe(true);
    });

    it('changes backgroundColor to var(--indicator-late) after LATE_THRESHOLD_MS timer fires', () => {
      const { result, rerender } = renderHook(({ ts }) => usePulseIndicator(ts), {
        initialProps: { ts: 0 },
      });

      const ping = makeDiv();
      const dot = makeDiv();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result.current.pingRef as any).current = ping;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result.current.dotRef as any).current = dot;

      act(() => {
        rerender({ ts: 1700000002000 });
      });

      // Find the late timer (delay === LATE_THRESHOLD_MS)
      const lateEntry = [...timerCallbacks.entries()].find(([, v]) => v.delay === LATE_THRESHOLD_MS);
      expect(lateEntry).toBeDefined();

      act(() => {
        lateEntry![1].fn();
      });

      expect(ping.style.backgroundColor).toBe('var(--indicator-late)');
      expect(dot.style.backgroundColor).toBe('var(--indicator-late)');
    });

    it('schedules both pulse and late timers on a new timestamp', () => {
      const { rerender } = renderHook(({ ts }) => usePulseIndicator(ts), {
        initialProps: { ts: 0 },
      });

      act(() => {
        rerender({ ts: 1700000003000 });
      });

      const delays = [...timerCallbacks.values()].map((v) => v.delay);
      expect(delays).toContain(PULSE_DURATION_MS);
      expect(delays).toContain(LATE_THRESHOLD_MS);
    });

    it('cancels both timers on unmount and prevents DOM mutations', () => {
      const { result, rerender, unmount } = renderHook(({ ts }) => usePulseIndicator(ts), {
        initialProps: { ts: 0 },
      });

      const ping = makeDiv();
      const dot = makeDiv();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result.current.pingRef as any).current = ping;
      // eslint-define-property @typescript-eslint/no-explicit-any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result.current.dotRef as any).current = dot;

      act(() => {
        rerender({ ts: 1700000004000 });
      });

      // Capture timer IDs before unmount
      const scheduledIds = [...timerCallbacks.keys()];
      expect(scheduledIds.length).toBeGreaterThanOrEqual(2);

      act(() => {
        unmount();
      });

      // Both timers should be cleared
      for (const id of scheduledIds) {
        expect(clearedTimers.has(id)).toBe(true);
      }
    });

    it('does not mutate DOM when cancelled flag is set before timers fire', () => {
      const { result, rerender, unmount } = renderHook(({ ts }) => usePulseIndicator(ts), {
        initialProps: { ts: 0 },
      });

      const ping = makeDiv();
      const dot = makeDiv();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result.current.pingRef as any).current = ping;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result.current.dotRef as any).current = dot;

      act(() => {
        rerender({ ts: 1700000005000 });
      });

      // Record state just after animation starts
      const bgAfterStart = ping.style.backgroundColor; // 'var(--indicator-active)'

      // Capture callbacks before unmount cancels them
      const pulseEntry = [...timerCallbacks.entries()].find(([, v]) => v.delay === PULSE_DURATION_MS);
      const lateEntry = [...timerCallbacks.entries()].find(([, v]) => v.delay === LATE_THRESHOLD_MS);

      // Unmount sets cancelled = true
      act(() => {
        unmount();
      });

      // Fire the raw callbacks after cancellation - they should be no-ops
      act(() => {
        pulseEntry![1].fn();
        lateEntry![1].fn();
      });

      // DOM should be unchanged: cancelled flag blocks timer callbacks from writing
      expect(ping.style.backgroundColor).toBe(bgAfterStart);
      expect(dot.style.backgroundColor).toBe(bgAfterStart);
      // animate-ping was added by the initial trigger; pulse timer is the one that removes it,
      // but since cancelled=true the timer callback is a no-op → class remains (not removed)
      expect(ping.classList.contains('animate-ping')).toBe(true);
    });
  });
});
