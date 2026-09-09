import { useCallback, useSyncExternalStore } from 'react';
import { MOBILE_BREAKPOINT, NAV_BREAKPOINT } from '@/lib/constants/breakpoints';

const NOOP_UNSUBSCRIBE = () => {};

/**
 * Window-scoped, unlike DataTable's container-scoped ResizeObserver: use this for
 * chrome that reacts to the device, the ResizeObserver for anything that must also
 * react to a narrow container.
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

export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
}

export function useIsCompactNav(): boolean {
  return useMediaQuery(`(max-width: ${NAV_BREAKPOINT - 1}px)`);
}

export function useIsTouch(): boolean {
  return useMediaQuery('(hover: none), (pointer: coarse)');
}
