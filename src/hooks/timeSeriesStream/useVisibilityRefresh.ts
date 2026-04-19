import { useEffect, useRef } from 'react';

interface UseVisibilityRefreshOptions {
  /** Callback invoked when the page becomes visible and the cooldown has elapsed. */
  onRefresh: () => void;
  /** Minimum time (ms) between successive refreshes. Guards against flapping visibility events. */
  cooldownMs: number;
  /** Ref that tracks the timestamp of the most recent refresh (shared with the orchestrator). */
  lastRefreshRef: React.RefObject<number>;
}

/**
 * Re-triggers a refresh callback when the document becomes visible again.
 *
 * Uses a shared `lastRefreshRef` so the cooldown is observed across other refresh sources
 * (preload, periodic refresh) rather than each consumer keeping an independent timer.
 */
export function useVisibilityRefresh({ onRefresh, cooldownMs, lastRefreshRef }: UseVisibilityRefreshOptions): void {
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastRefreshRef.current < cooldownMs) return;
      onRefreshRef.current();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [cooldownMs]);
}
