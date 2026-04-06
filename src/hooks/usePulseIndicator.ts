import { useRef, useEffect } from 'react';
import { PULSE_DURATION_MS, LATE_THRESHOLD_MS } from '@/lib/constants/ui-timing';

/**
 * Manages the pulse indicator animation for a streaming data row.
 *
 * Triggers a CSS ping animation on each new update and transitions the
 * indicator color to "late" when no update arrives within `LATE_THRESHOLD_MS`.
 * All DOM mutations are performed directly via refs to avoid re-renders per tick.
 *
 * @param lastUpdatedMs - Unix timestamp (ms) of the most recent data update.
 * @returns Refs to attach to the indicator wrapper, ping, and dot elements.
 */
export function usePulseIndicator(lastUpdatedMs: number): {
  indicatorRef: React.RefObject<HTMLDivElement | null>;
  pingRef: React.RefObject<HTMLDivElement | null>;
  dotRef: React.RefObject<HTMLDivElement | null>;
} {
  const lastUpdatedMsRef = useRef(lastUpdatedMs);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const pingRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (lastUpdatedMs > 0 && lastUpdatedMs !== lastUpdatedMsRef.current) {
      lastUpdatedMsRef.current = lastUpdatedMs;

      const indicator = indicatorRef.current;
      if (indicator) indicator.title = `Last updated: ${new Date(lastUpdatedMs).toLocaleTimeString()}`;

      const ping = pingRef.current;
      const dot = dotRef.current;
      if (ping) { ping.classList.add('opacity-100', 'animate-ping'); ping.classList.remove('opacity-0'); }
      if (ping && dot) {
        ping.style.backgroundColor = 'var(--indicator-active)';
        dot.style.backgroundColor = 'var(--indicator-active)';
      }

      let cancelled = false;
      const pulseTimer = setTimeout(() => {
        if (!cancelled && ping) { ping.classList.remove('opacity-100', 'animate-ping'); ping.classList.add('opacity-0'); }
      }, PULSE_DURATION_MS);
      const lateTimer = setTimeout(() => {
        if (!cancelled && ping) ping.style.backgroundColor = 'var(--indicator-late)';
        if (!cancelled && dot) dot.style.backgroundColor = 'var(--indicator-late)';
      }, LATE_THRESHOLD_MS);
      return () => {
        cancelled = true;
        clearTimeout(pulseTimer);
        clearTimeout(lateTimer);
      };
    }
  }, [lastUpdatedMs]);

  return { indicatorRef, pingRef, dotRef };
}
