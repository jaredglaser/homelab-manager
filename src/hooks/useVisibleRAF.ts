import { useEffect, useRef, type RefObject } from 'react';

/**
 * Small rootMargin so charts start animating just before scrolling into view.
 * Prevents visible pop-in while still pausing when well off-screen.
 */
const ROOT_MARGIN = '100px';

/**
 * Runs a requestAnimationFrame callback only while `targetRef` intersects the viewport.
 *
 * Pauses the loop when the element scrolls out of view and resumes when it comes back,
 * avoiding perpetual 60fps work for off-screen charts/sparklines.
 *
 * Behavior details:
 * - Observer uses `rootMargin: 100px` and the default threshold (0), so the loop
 *   starts on any pixel of overlap with the expanded viewport.
 * - Latest `callback` is always invoked (no stale closure), so callers can pass
 *   a freshly-created closure on each render without re-subscribing the observer.
 * - Fallback: if `IntersectionObserver` is unavailable, its construction throws,
 *   or `observe()` throws (broken polyfill, detached node, strict environments),
 *   the hook logs an error and runs an unconditional rAF loop, preserving prior
 *   behavior.
 * - The effect re-runs only when the `targetRef` object identity changes, NOT
 *   when `targetRef.current` is reassigned. Pass a ref to a stable DOM element.
 *   If `targetRef.current` is null at effect-run time, the hook warns and
 *   no-ops; this almost always indicates the wrapper element is mounted
 *   conditionally and the gating won't work as expected.
 * - If `callback` throws, the loop is torn down for this mount to avoid an
 *   infinite error stream. Visibility can still resume the loop on the next
 *   intersection toggle, so a transient throw self-heals on the next
 *   isIntersecting:false → true transition.
 *
 * @param targetRef Ref to the DOM element whose visibility gates the loop.
 * @param callback  Frame callback invoked with the rAF timestamp.
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
          const entry = entries[0];
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
