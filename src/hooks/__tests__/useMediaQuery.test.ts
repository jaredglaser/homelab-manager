import { describe, expect, it, afterEach } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import {
  useIsCompactNav,
  useIsMobile,
  useIsTouch,
  useMediaQuery,
} from '@/hooks/useMediaQuery';

interface MockList {
  matches: boolean;
  media: string;
  listeners: Set<() => void>;
}

const originalMatchMedia = window.matchMedia;
const lists = new Map<string, MockList>();

function installMatchMedia(initial: (query: string) => boolean) {
  lists.clear();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      let list = lists.get(query);
      if (!list) {
        list = { matches: initial(query), media: query, listeners: new Set() };
        lists.set(query, list);
      }
      return {
        get matches() {
          return list.matches;
        },
        media: query,
        addEventListener: (_: string, cb: () => void) => list.listeners.add(cb),
        removeEventListener: (_: string, cb: () => void) => list.listeners.delete(cb),
      };
    },
  });
}

function emitChange(query: string, matches: boolean) {
  const list = lists.get(query);
  if (!list) throw new Error(`no mock media query list for ${query}`);
  list.matches = matches;
  act(() => {
    for (const cb of list.listeners) cb();
  });
}

function removeMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: undefined,
  });
}

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
  lists.clear();
});

describe('useMediaQuery', () => {
  it('reports the initial match state of the query', () => {
    installMatchMedia(() => true);
    const { result } = renderHook(() => useMediaQuery('(max-width: 500px)'));
    expect(result.current).toBe(true);
  });

  it('re-renders when the query starts matching', () => {
    installMatchMedia(() => false);
    const { result } = renderHook(() => useMediaQuery('(max-width: 500px)'));
    expect(result.current).toBe(false);

    emitChange('(max-width: 500px)', true);
    expect(result.current).toBe(true);
  });

  it('re-renders when the query stops matching', () => {
    installMatchMedia(() => true);
    const { result } = renderHook(() => useMediaQuery('(max-width: 500px)'));

    emitChange('(max-width: 500px)', false);
    expect(result.current).toBe(false);
  });

  it('removes its listener on unmount', () => {
    installMatchMedia(() => false);
    const { unmount } = renderHook(() => useMediaQuery('(max-width: 500px)'));
    expect(lists.get('(max-width: 500px)')!.listeners.size).toBe(1);

    unmount();
    expect(lists.get('(max-width: 500px)')!.listeners.size).toBe(0);
  });

  it('resubscribes when the query string changes', () => {
    installMatchMedia((query) => query === '(min-width: 900px)');
    const { result, rerender } = renderHook(({ q }) => useMediaQuery(q), {
      initialProps: { q: '(max-width: 500px)' },
    });
    expect(result.current).toBe(false);

    rerender({ q: '(min-width: 900px)' });
    expect(result.current).toBe(true);
    expect(lists.get('(max-width: 500px)')!.listeners.size).toBe(0);
    expect(lists.get('(min-width: 900px)')!.listeners.size).toBe(1);
  });

  it('reports false when matchMedia is unavailable', () => {
    removeMatchMedia();
    const { result } = renderHook(() => useMediaQuery('(max-width: 500px)'));
    expect(result.current).toBe(false);
  });
});

describe('breakpoint hooks', () => {
  it('useIsMobile queries one pixel below the lg breakpoint', () => {
    installMatchMedia(() => true);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
    expect([...lists.keys()]).toEqual(['(max-width: 1023px)']);
  });

  it('useIsCompactNav queries one pixel below the md breakpoint', () => {
    installMatchMedia(() => false);
    renderHook(() => useIsCompactNav());
    expect([...lists.keys()]).toEqual(['(max-width: 767px)']);
  });

  it('useIsTouch queries hover and pointer capability', () => {
    installMatchMedia(() => true);
    const { result } = renderHook(() => useIsTouch());
    expect(result.current).toBe(true);
    expect([...lists.keys()]).toEqual(['(hover: none), (pointer: coarse)']);
  });
});
