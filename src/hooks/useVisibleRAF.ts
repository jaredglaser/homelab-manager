import { useEffect, useRef, type RefObject } from 'react';
import { subscribeRafTicker } from '@/lib/utils/raf-ticker';

/**
 * Small rootMargin so charts start animating just before scrolling into view.
 * Prevents visible pop-in while still pausing when well off-screen.
 */
const ROOT_MARGIN = '100px';

/**
 * Runs a requestAnimationFrame callback only while `targetRef` intersects the
 * viewport, pausing when off-screen to avoid perpetual 60fps work.
 *
 * Callbacks run on a process-wide shared ticker rather than a per-mount loop.
 * Return true to hold full vsync rate. Returning nothing drops to its idle cadence.
 * Pass no callback for notification-only visibility tracking: no ticker subscription,
 * only onActiveChange flips.
 *
 * - `callback` is always called with the latest closure — callers can pass a
 *   freshly-created function each render without re-subscribing the observer.
 * - The effect re-runs on `targetRef` identity changes only, NOT on
 *   `targetRef.current` reassignment. Pass a ref to a stable DOM element.
 * - Falls back to an unconditional ticker subscription if `IntersectionObserver`
 *   setup throws (missing API, broken polyfill, detached node).
 * - If `callback` throws, this mount unsubscribes from the ticker but
 *   self-heals on the next isIntersecting:false → true transition.
 */
export function useVisibleRAF(
  targetRef: RefObject<Element | null>,
  callback: ((timestamp: number) => boolean | void) | undefined,
  onActiveChange?: (active: boolean) => void,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const el = targetRef.current;
    if (!el) {
      console.warn('useVisibleRAF: targetRef.current is null at effect-run time; loop will not start.');
      return;
    }

    let unsubscribe: (() => void) | null = null;
    let visible = false;
    let lastNotified: boolean | null = null;

    // Fires only on observed-state changes, including the IO initial delivery,
    // which can be isIntersecting:false before any start().
    const notify = (active: boolean) => {
      if (lastNotified === active) return;
      lastNotified = active;
      onActiveChange?.(active);
    };

    const stop = () => {
      if (visible) {
        visible = false;
        unsubscribe?.();
        unsubscribe = null;
        notify(false);
      }
    };

    const tick = (ts: number) => {
      try {
        if (!callbackRef.current) return;
        return callbackRef.current(ts);
      } catch (err) {
        console.error('useVisibleRAF: callback threw; stopping rAF loop for this mount.', err);
        stop();
      }
    };

    const start = () => {
      if (visible) return;
      visible = true;
      if (callback) unsubscribe = subscribeRafTicker(tick);
    };

    // Environments without IntersectionObserver (older test shims): run unconditionally.
    if (typeof IntersectionObserver === 'undefined') {
      start();
      return () => stop();
    }

    try {
      const observer = new IntersectionObserver(
        (entries) => {
          // Act on the LATEST entry: a batched dispatch can carry two transitions
          // for one target. A canvas mounting with its content-visibility:auto row
          // on tab return arrives as a skipped-subtree 0x0 "false" then the real
          // "true", so only the last entry is the correct current state.
          const entry = entries[entries.length - 1];
          if (!entry) return;
          if (entry.isIntersecting) start();
          else stop();
          notify(entry.isIntersecting);
        },
        { rootMargin: ROOT_MARGIN },
      );
      observer.observe(el);
      return () => {
        try {
          observer.disconnect();
        } catch (err) {
          console.error('useVisibleRAF: observer.disconnect threw during cleanup.', err);
        }
        stop();
      };
    } catch (err) {
      console.error('useVisibleRAF: IntersectionObserver setup failed; running rAF unconditionally.', err);
      start();
      return () => stop();
    }
  }, [targetRef]);
}
