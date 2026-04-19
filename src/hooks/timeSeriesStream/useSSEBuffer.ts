import { useCallback, useEffect, useRef, useState } from 'react';
import { mergeWithEviction } from './timeWindowTrim';

interface UseSSEBufferOptions<TRow> {
  /** Ref-wrapped getters so callers can pass inline arrows without resubscribing the flush interval. */
  getKeyRef: React.RefObject<(row: TRow) => string>;
  getTimeRef: React.RefObject<(row: TRow) => number>;
  /** Time window (seconds) after which rows are evicted from the front. */
  windowSeconds: number;
  /** Interval (ms) at which queued rows are flushed into the buffer. */
  updateIntervalMs: number;
}

interface UseSSEBufferResult<TRow> {
  /** Sorted (ascending by time) rows within the time window. */
  sortedRows: TRow[];
  /** True once any rows have been seeded or flushed. */
  hasData: boolean;
  /** Queues rows from an SSE message. They are merged on the next flush tick. */
  enqueue: (incoming: TRow[]) => void;
  /**
   * Atomically replaces the buffer with `rows`, optionally preserving a live tail.
   * Used by preload seeding and periodic refresh.
   *
   * @param opts.markHasData - when true (preload seeding) also flips `hasData` to true.
   *   Refresh callers leave this false so `hasData` is never transitioned by refresh alone,
   *   preserving the original semantics where `hasData` is driven strictly by seed/flush.
   * @param opts.preserveLiveTail - when true, SSE rows arrived after the preload snapshot's
   *   latest timestamp are stitched onto the replacement so the live tail is seamless.
   */
  replaceBuffer: (rows: TRow[], opts?: { preserveLiveTail?: boolean; markHasData?: boolean }) => void;
  /** Timestamp (ms) of the most recent data event. `null` until the first seeding/flush. */
  lastDataTimeRef: React.RefObject<number | null>;
  /** Live reference to the sorted buffer, for callers that need a synchronous read. */
  sortedRef: React.RefObject<TRow[]>;
}

/**
 * Manages a time-windowed buffer of rows fed by SSE and seeded by preload.
 *
 * Responsibilities:
 *  - Holds the sorted buffer state (single source of truth for `rows`).
 *  - Tracks a dedup set so overlapping preload/SSE entries are not duplicated.
 *  - Accumulates incoming SSE rows in a pending queue and flushes them on a fixed interval,
 *    merging with eviction so eviction runs alongside appends for a single state update per tick.
 *  - Exposes `replaceBuffer` for atomic swaps (preload seeding, periodic refresh).
 */
export function useSSEBuffer<TRow>({
  getKeyRef,
  getTimeRef,
  windowSeconds,
  updateIntervalMs,
}: UseSSEBufferOptions<TRow>): UseSSEBufferResult<TRow> {
  const [sortedRows, setSortedRows] = useState<TRow[]>([]);
  const sortedRef = useRef<TRow[]>([]);
  const dedupRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<TRow[]>([]);
  const [hasData, setHasData] = useState(false);
  const lastDataTimeRef = useRef<number | null>(null);

  const enqueue = useCallback((incoming: TRow[]) => {
    pendingRef.current.push(...incoming);
  }, []);

  const replaceBuffer = useCallback(
    (rows: TRow[], opts?: { preserveLiveTail?: boolean; markHasData?: boolean }) => {
      if (rows.length === 0) return;
      const sorted = [...rows].sort((a, b) => getTimeRef.current(a) - getTimeRef.current(b));

      let merged = sorted;
      if (opts?.preserveLiveTail) {
        // Preserve SSE rows too recent to have been committed to the DB yet (typically last 1-5s).
        // These sit beyond the preload snapshot and must be stitched in so the live tail is seamless.
        const preloadMaxTime = getTimeRef.current(sorted[sorted.length - 1]);
        const liveTail = sortedRef.current.filter(r => getTimeRef.current(r) > preloadMaxTime);
        if (liveTail.length > 0) merged = [...sorted, ...liveTail];
      }

      // Atomically rebuild dedup set and swap the buffer - single setSortedRows call = one re-render
      const newDedup = new Set<string>();
      for (const row of merged) newDedup.add(getKeyRef.current(row));
      dedupRef.current = newDedup;
      sortedRef.current = merged;
      setSortedRows(merged);
      if (opts?.markHasData) setHasData(true);
      lastDataTimeRef.current = Date.now();
    },
    [getKeyRef, getTimeRef],
  );

  // Flush pending rows into the sorted array on a fixed interval.
  // O(k log k + log n) per flush vs O(n log n) with full re-sort:
  //   - new rows (k) are sorted among themselves and appended at the end
  //   - expired rows are evicted from the front via binary search
  useEffect(() => {
    const id = setInterval(() => {
      const pending = pendingRef.current;
      if (pending.length === 0) return;
      pendingRef.current = [];

      const now = Date.now();
      const cutoff = now - windowSeconds * 1000;
      const dedup = dedupRef.current;
      const sorted = sortedRef.current;

      // Filter to new unique rows only - skips preload/SSE overlap duplicates
      const newRows: TRow[] = [];
      for (const row of pending) {
        const key = getKeyRef.current(row);
        if (!dedup.has(key)) {
          dedup.add(key);
          newRows.push(row);
        }
      }

      // Sort the incoming batch (small - typically one per container per second)
      newRows.sort((a, b) => getTimeRef.current(a) - getTimeRef.current(b));

      const { next, cutoffIdx } = mergeWithEviction(sorted, newRows, cutoff, getTimeRef.current);

      // Remove evicted keys from the dedup set
      for (let i = 0; i < cutoffIdx; i++) {
        dedup.delete(getKeyRef.current(sorted[i]));
      }

      sortedRef.current = next;
      setSortedRows(next);
      setHasData(true);
      lastDataTimeRef.current = now;
    }, updateIntervalMs);
    return () => clearInterval(id);
  }, [windowSeconds, updateIntervalMs, getKeyRef, getTimeRef]);

  return { sortedRows, hasData, enqueue, replaceBuffer, lastDataTimeRef, sortedRef };
}
