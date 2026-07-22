import { useCallback, useEffect, useRef, useState } from 'react';
import { mergeWithEviction } from './timeWindowTrim';

type BufferAccessors<TRow> = {
  key: (row: TRow) => PropertyKey;
  time: (row: TRow) => number;
};

interface UseSSEBufferOptions<TRow, A extends BufferAccessors<TRow>> {
  accessorsRef: React.RefObject<A>;
  windowSeconds: number;
  updateIntervalMs: number;
}

/**
 * Seed = initial preload (flips `hasData`, no live-tail stitching).
 * Refresh = periodic / post-mount (preserves in-flight SSE rows beyond the snapshot, leaves `hasData` alone).
 */
export type ReplaceBufferOptions =
  | { mode: 'seed' }
  | { mode: 'refresh'; preserveLiveTail?: boolean };

export interface ReplaceBufferStats {
  bucketed: number;
  liveTail: number;
  total: number;
}

interface UseSSEBufferResult<TRow> {
  sortedRows: TRow[];
  hasData: boolean;
  enqueue: (incoming: TRow[]) => void;
  replaceBuffer: (rows: TRow[], opts: ReplaceBufferOptions) => ReplaceBufferStats;
  getLastDataTime: () => number | null;
  resetFirstFlush: () => void;
}

/**
 * Time-windowed buffer of rows fed by SSE and seeded by preload.
 *
 * Owns the sorted buffer (single source of truth for `rows`), a dedup set against
 * preload/SSE overlap, and a pending queue flushed on a fixed interval so eviction
 * piggybacks on append. `replaceBuffer` performs atomic swaps for preload/refresh.
 */
export function useSSEBuffer<TRow, A extends BufferAccessors<TRow>>({
  accessorsRef,
  windowSeconds,
  updateIntervalMs,
}: UseSSEBufferOptions<TRow, A>): UseSSEBufferResult<TRow> {
  const [sortedRows, setSortedRows] = useState<TRow[]>([]);
  const sortedRef = useRef<TRow[]>([]);
  const dedupRef = useRef<Set<PropertyKey>>(new Set());
  const pendingRef = useRef<TRow[]>([]);
  const [hasData, setHasData] = useState(false);
  const lastDataTimeRef = useRef<number | null>(null);

  // Flush pending rows into the sorted array.
  // O(k log k + log n) per flush vs O(n log n) with full re-sort:
  //   - new rows (k) are sorted among themselves and appended at the end
  //   - expired rows are evicted from the front via binary search
  const flush = useCallback(() => {
    const pending = pendingRef.current;
    if (pending.length === 0) return;
    pendingRef.current = [];

    const now = Date.now();
    const cutoff = now - windowSeconds * 1000;
    const dedup = dedupRef.current;
    const sorted = sortedRef.current;
    const { key, time } = accessorsRef.current;

    const newRows: TRow[] = [];
    for (const row of pending) {
      const k = key(row);
      if (!dedup.has(k)) {
        dedup.add(k);
        newRows.push(row);
      }
    }

    newRows.sort((a, b) => time(a) - time(b));

    const { next, cutoffIdx } = mergeWithEviction(sorted, newRows, cutoff, time);

    for (let i = 0; i < cutoffIdx; i++) {
      dedup.delete(key(sorted[i]));
    }

    sortedRef.current = next;
    setSortedRows(next);
    setHasData(true);
    lastDataTimeRef.current = now;
  }, [windowSeconds, accessorsRef]);

  const flushRef = useRef(flush);
  flushRef.current = flush;
  // Gates the immediate paint of the first frame after a (re)connect. Initialized
  // false at mount (covers tab-switch remounts); resetFirstFlush re-arms it for an
  // in-place SSE reconnect, which keeps the same hook instance.
  const firstFlushDoneRef = useRef(false);

  const enqueue = useCallback((incoming: TRow[]) => {
    pendingRef.current.push(...incoming);
    // First frame after connect paints immediately instead of waiting up to
    // updateIntervalMs; after a tab switch that saves up to a full flush
    // interval before the sparklines and values catch up. Subsequent frames
    // keep the fixed cadence so eviction still piggybacks on batched appends.
    if (!firstFlushDoneRef.current) {
      firstFlushDoneRef.current = true;
      flushRef.current();
    }
  }, []);

  // Re-arm the immediate first flush so the first frame after an SSE reconnect
  // paints at once instead of waiting for the next interval. The hook instance
  // survives a reconnect, so the mount-time gate alone would not cover it.
  const resetFirstFlush = useCallback(() => {
    firstFlushDoneRef.current = false;
  }, []);

  const replaceBuffer = useCallback(
    (rows: TRow[], opts: ReplaceBufferOptions): ReplaceBufferStats => {
      if (rows.length === 0) return { bucketed: 0, liveTail: 0, total: 0 };
      const { key, time } = accessorsRef.current;
      const sorted = [...rows].sort((a, b) => time(a) - time(b));

      let merged = sorted;
      let liveTailLen = 0;
      if (opts.mode === 'refresh' && opts.preserveLiveTail) {
        const preloadMaxTime = time(sorted[sorted.length - 1]);
        const liveTail = sortedRef.current.filter(r => time(r) > preloadMaxTime);
        liveTailLen = liveTail.length;
        if (liveTailLen > 0) merged = [...sorted, ...liveTail];
      }

      const newDedup = new Set<PropertyKey>();
      for (const row of merged) newDedup.add(key(row));
      dedupRef.current = newDedup;
      sortedRef.current = merged;
      setSortedRows(merged);
      if (opts.mode === 'seed') setHasData(true);
      lastDataTimeRef.current = Date.now();
      return { bucketed: sorted.length, liveTail: liveTailLen, total: merged.length };
    },
    [accessorsRef],
  );

  useEffect(() => {
    const id = setInterval(() => flushRef.current(), updateIntervalMs);
    return () => clearInterval(id);
  }, [updateIntervalMs]);

  const getLastDataTime = useCallback(() => lastDataTimeRef.current, []);

  return { sortedRows, hasData, enqueue, replaceBuffer, getLastDataTime, resetFirstFlush };
}
