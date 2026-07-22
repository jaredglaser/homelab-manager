import { useEffect, useRef, type RefObject } from 'react';

/**
 * Small rootMargin so charts start animating just before scrolling into view.
 * Prevents visible pop-in while still pausing when well off-screen.
 */
const ROOT_MARGIN = '100px';

/**
 * Runs a requestAnimationFrame callback only while `targetRef` intersects the
 * viewport, pausing when off-screen to avoid perpetual 60fps work.
 *
 * - `callback` is always called with the latest closure — callers can pass a
 *   freshly-created function each render without re-subscribing the observer.
 * - The effect re-runs on `targetRef` identity changes only, NOT on
 *   `targetRef.current` reassignment. Pass a ref to a stable DOM element.
 * - Falls back to an unconditional rAF loop if `IntersectionObserver` setup
 *   throws (missing API, broken polyfill, detached node).
 * - If `callback` throws, the loop stops for this mount but self-heals on the
 *   next isIntersecting:false → true transition.
 */
export function useVisibleRAF(
  targetRef: RefObject<Element | null>,
  callback: (timestamp: number) => void,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const el = targetRef.current;
    if (!el) {
      console.warn('useVisibleRAF: targetRef.current is null at effect-run time; loop will not start.');
      return;
    }

    let rafId: number | null = null;
    let visible = false;

    const stop = () => {
      if (visible) {
        visible = false;
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    const tick = (ts: number) => {
      try {
        callbackRef.current(ts);
      } catch (err) {
        console.error('useVisibleRAF: callback threw; stopping rAF loop for this mount.', err);
        stop();
        return;
      }
      rafId = requestAnimationFrame(tick);
    };

    const start = () => {
      if (!visible) {
        visible = true;
        rafId = requestAnimationFrame(tick);
      }
    };

    // Environments without IntersectionObserver (older test shims): run unconditionally.
    if (typeof IntersectionObserver === 'undefined') {
      start();
      return () => stop();
    }

    try {
      const observer = new IntersectionObserver(
        (entries) => {
          // Act on the LATEST entry: deliveries are batched, and a target can
          // transition twice within one dispatch. Sparkline canvases mount in
          // the same commit as their content-visibility:auto row on tab
          // return, so the observer's initial entry is a skipped-subtree 0x0
          // "not intersecting" followed by the real "intersecting" one; acting
          // on entries[0] discarded the correction and left the rAF loop off
          // (blank canvases) until the element next left and re-entered view.
          const entry = entries[entries.length - 1];
          if (!entry) return;
          if (entry.isIntersecting) start();
          else stop();
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
