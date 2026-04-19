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
 * avoiding perpetual 60fps work for off-screen charts/sparklines. Falls back to an
 * always-on rAF loop if `IntersectionObserver` is unavailable.
 *
 * @param targetRef Ref to the DOM element whose visibility gates the loop.
 * @param callback  Frame callback. Latest `callback` is always invoked (no stale closure).
 */
export function useVisibleRAF(
  targetRef: RefObject<Element | null>,
  callback: (timestamp: number) => void,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return;

    let rafId: number | null = null;
    let visible = false;

    const tick = (ts: number) => {
      callbackRef.current(ts);
      rafId = requestAnimationFrame(tick);
    };

    const start = () => {
      if (!visible) {
        visible = true;
        rafId = requestAnimationFrame(tick);
      }
    };

    const stop = () => {
      if (visible) {
        visible = false;
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    // Environments without IntersectionObserver (older test shims) — run unconditionally.
    if (typeof IntersectionObserver === 'undefined') {
      start();
      return () => stop();
    }

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
      observer.disconnect();
      stop();
    };
  }, [targetRef]);
}
