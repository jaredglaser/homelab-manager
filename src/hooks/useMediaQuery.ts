import { useCallback, useSyncExternalStore } from 'react';
import { MOBILE_BREAKPOINT, NAV_BREAKPOINT } from '@/lib/constants/breakpoints';

const NOOP_UNSUBSCRIBE = () => {};

/**
 * Subscribe to a CSS media query.
 *
 * Window-scoped, unlike DataTable's container-scoped ResizeObserver: use this
 * for chrome that reacts to the device (nav, dialogs, page layout) and the
 * ResizeObserver for anything that must also react to a narrow container.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return NOOP_UNSUBSCRIBE;
      }
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia(query).matches;
  }, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** True below the `lg` breakpoint: the viewport gets the single-column touch layout. */
export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
}

/** True below the `md` breakpoint: the header tab bar is collapsed into the drawer. */
export function useIsCompactNav(): boolean {
  return useMediaQuery(`(max-width: ${NAV_BREAKPOINT - 1}px)`);
}

/**
 * True when the primary input is touch. Drives tap-to-open on menus that
 * otherwise open on hover, which a touch device can never satisfy.
 */
export function useIsTouch(): boolean {
  return useMediaQuery('(hover: none), (pointer: coarse)');
}
