import { describe, it, expect, mock } from 'bun:test';
import { useRef } from 'react';
import { renderHook, act } from '@testing-library/react';
import { useVisibilityRefresh } from '../../timeSeriesStream/useVisibilityRefresh';

function simulateVisibilityChange(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, writable: true, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useVisibilityRefresh', () => {
  it('calls onRefresh when visibility changes to visible and cooldown has elapsed', () => {
    const onRefresh = mock(() => {});
    renderHook(() => {
      const lastRefreshRef = useRef(0);
      useVisibilityRefresh({ onRefresh, cooldownMs: 5000, lastRefreshRef });
    });

    act(() => simulateVisibilityChange('visible'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not call onRefresh when visibility changes to hidden', () => {
    const onRefresh = mock(() => {});
    renderHook(() => {
      const lastRefreshRef = useRef(0);
      useVisibilityRefresh({ onRefresh, cooldownMs: 5000, lastRefreshRef });
    });

    act(() => simulateVisibilityChange('hidden'));
    expect(onRefresh).toHaveBeenCalledTimes(0);
  });

  it('skips refresh if last refresh was within cooldown', () => {
    const onRefresh = mock(() => {});
    renderHook(() => {
      const lastRefreshRef = useRef(Date.now());
      useVisibilityRefresh({ onRefresh, cooldownMs: 5000, lastRefreshRef });
    });

    act(() => simulateVisibilityChange('visible'));
    expect(onRefresh).toHaveBeenCalledTimes(0);
  });

  it('always invokes the latest onRefresh callback', () => {
    const first = mock(() => {});
    const second = mock(() => {});
    const { rerender } = renderHook(
      ({ cb }: { cb: () => void }) => {
        const lastRefreshRef = useRef(0);
        useVisibilityRefresh({ onRefresh: cb, cooldownMs: 5000, lastRefreshRef });
      },
      { initialProps: { cb: first } },
    );

    rerender({ cb: second });

    act(() => simulateVisibilityChange('visible'));
    expect(first).toHaveBeenCalledTimes(0);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('removes the listener on unmount', () => {
    const onRefresh = mock(() => {});
    const { unmount } = renderHook(() => {
      const lastRefreshRef = useRef(0);
      useVisibilityRefresh({ onRefresh, cooldownMs: 5000, lastRefreshRef });
    });

    unmount();

    act(() => simulateVisibilityChange('visible'));
    expect(onRefresh).toHaveBeenCalledTimes(0);
  });
});
