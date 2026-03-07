import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useEventSource } from './useEventSource';

const STALE_THRESHOLD_MS = 30000;
const STALE_CHECK_INTERVAL_MS = 5000;
const PRELOAD_TIMEOUT_MS = 8000;
export const VISIBILITY_REFRESH_COOLDOWN_MS = 5000;

interface UseTimeSeriesStreamOptions<TRow> {
  sseUrl: string;
  preloadFn: () => Promise<TRow[]>;
  getKey: (row: TRow) => string;
  getTime: (row: TRow) => number;
  getEntity: (row: TRow) => string;
  windowSeconds?: number; // default 60
  updateIntervalMs?: number; // default 1000
  /** If set, re-fetches bucketed history at this interval (ms) to prevent unbounded buffer growth. */
  refreshIntervalMs?: number;
  /** Cached preload data (e.g. from TanStack Query). If provided, seeds the buffer immediately instead of fetching. */
  initialData?: TRow[];
  debug?: boolean;
}

interface UseTimeSeriesStreamResult<TRow> {
  rows: TRow[];
  latestByEntity: Map<string, TRow>;
  isConnected: boolean;
  error: Error | null;
  hasData: boolean;
  isStale: boolean;
}

/**
 * Find the first index in a time-sorted array whose time is greater than or equal to a cutoff.
 *
 * The input array must be sorted in ascending order according to `getTime`.
 *
 * @param arr - Array of items sorted by time
 * @param cutoff - Time cutoff (inclusive)
 * @param getTime - Function that returns the time value for an item
 * @returns The index of the first element with `getTime(element) >= cutoff`; returns `arr.length` if no such element exists
 */
function lowerBound<T>(arr: T[], cutoff: number, getTime: (item: T) => number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (getTime(arr[mid]) < cutoff) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Provides a time-windowed stream of rows by preloading historical data and merging subsequent SSE updates.
 *
 * @param options - Configuration options for the stream
 * @param options.sseUrl - Server-Sent Events URL to subscribe for incremental updates
 * @param options.preloadFn - Function that resolves to an array of historical rows to seed the buffer
 * @param options.getKey - Function that returns a unique key for a row
 * @param options.getTime - Function that returns the timestamp (ms) for a row
 * @param options.getEntity - Function that returns the entity identifier for a row (used to compute latest-per-entity)
 * @param options.windowSeconds - Time window in seconds to retain rows (default: 60)
 * @param options.updateIntervalMs - Interval in milliseconds to flush queued SSE rows into the buffer (default: 1000)
 * @param options.debug - Enable debug logging
 * @returns An object containing:
 *  - `rows`: the current sorted array of rows within the time window,
 *  - `latestByEntity`: a Map from entity id to the most recent row for that entity,
 *  - `isConnected`: whether the SSE connection is active,
 *  - `error`: the composed error from preload/SSE/service, or `null`,
 *  - `hasData`: `true` if any rows have been received or preloaded,
 *  - `isStale`: `true` if no new data has arrived recently (based on internal staleness thresholds)
 */
export function useTimeSeriesStream<TRow>({
  sseUrl,
  preloadFn,
  getKey,
  getTime,
  getEntity,
  windowSeconds = 60,
  updateIntervalMs = 1000,
  refreshIntervalMs,
  initialData,
  debug = false,
}: UseTimeSeriesStreamOptions<TRow>): UseTimeSeriesStreamResult<TRow> {
  // Primary sorted state - drives renders. sortedRef mirrors it for synchronous reads in the flush interval.
  const [sortedRows, setSortedRows] = useState<TRow[]>([]);
  const sortedRef = useRef<TRow[]>([]);
  // Dedup set: O(1) key lookup prevents duplicate entries from preload/SSE overlap
  const dedupRef = useRef<Set<string>>(new Set());

  const [hasData, setHasData] = useState(false);
  const lastDataTimeRef = useRef<number | null>(null);
  const [preloadError, setPreloadError] = useState<Error | null>(null);
  const [serviceError, setServiceError] = useState<Error | null>(null);
  const preloadedRef = useRef(false);

  // Keep refs up to date for use in callbacks and memoization
  // (callers pass inline arrows - refs give stable identities for useMemo)
  const getKeyRef = useRef(getKey);
  const getTimeRef = useRef(getTime);
  const getEntityRef = useRef(getEntity);
  const preloadFnRef = useRef(preloadFn);
  getKeyRef.current = getKey;
  getTimeRef.current = getTime;
  getEntityRef.current = getEntity;
  preloadFnRef.current = preloadFn;

  // Track last refresh time for visibility cooldown
  const lastRefreshRef = useRef(0);

  // Atomic buffer refresh — re-fetches bucketed history and swaps the buffer in one state update.
  // Declared before the preload effect so both the preload effect and later effects can reference it.
  // Stored as a ref so effects always invoke the latest closure without recreating intervals.
  const doRefreshRef = useRef<() => Promise<void>>(async () => {});
  doRefreshRef.current = async () => {
    let rows: TRow[];
    try {
      rows = await preloadFnRef.current();
    } catch {
      return; // silently ignore - next interval will retry
    }
    lastRefreshRef.current = Date.now();
    if (rows.length === 0) return;

    const sorted = [...rows].sort((a, b) => getTimeRef.current(a) - getTimeRef.current(b));
    const preloadMaxTime = getTimeRef.current(sorted[sorted.length - 1]);

    // Preserve SSE rows too recent to have been committed to the DB yet (typically last 1-5s).
    // These sit beyond the preload snapshot and must be stitched in so the live tail is seamless.
    const liveTail = sortedRef.current.filter(r => getTimeRef.current(r) > preloadMaxTime);
    const merged = liveTail.length > 0 ? [...sorted, ...liveTail] : sorted;

    // Atomically rebuild dedup set and swap the buffer - single setSortedRows call = one re-render
    const newDedup = new Set<string>();
    for (const row of merged) newDedup.add(getKeyRef.current(row));
    dedupRef.current = newDedup;
    sortedRef.current = merged;
    setSortedRows(merged);

    if (debug) {
      console.log(
        `[useTimeSeriesStream] Buffer refresh: ${sorted.length} bucketed + ${liveTail.length} live = ${merged.length} total`
      );
    }
  };

  // Seed the buffer from cached initialData or fetch via preloadFn.
  // Re-fetches when preloadFn changes (window size changed via settings).
  const initialDataRef = useRef(initialData);
  initialDataRef.current = initialData;

  useEffect(() => {
    if (preloadedRef.current) {
      // preloadFn changed after initial mount - window size changed, re-fetch history.
      void doRefreshRef.current();
      return;
    }
    preloadedRef.current = true;

    const seedRows = (rows: TRow[]) => {
      if (rows.length === 0) return;
      const sorted = [...rows].sort((a, b) => getTimeRef.current(a) - getTimeRef.current(b));
      const dedup = dedupRef.current;
      for (const row of sorted) dedup.add(getKeyRef.current(row));
      sortedRef.current = sorted;
      setSortedRows(sorted);
      setHasData(true);
      lastDataTimeRef.current = Date.now();
      lastRefreshRef.current = Date.now();
    };

    // Use cached data if available (e.g. from TanStack Query)
    if (initialDataRef.current && initialDataRef.current.length > 0) {
      seedRows(initialDataRef.current);
      return;
    }

    // Otherwise fetch from the server
    if (debug) console.log('[useTimeSeriesStream] Starting preload...');
    let preloadTimeoutId: ReturnType<typeof setTimeout>;
    const preloadTimeout = new Promise<never>((_, reject) => {
      preloadTimeoutId = setTimeout(() => reject(new Error('Database unavailable')), PRELOAD_TIMEOUT_MS);
    });
    Promise.race([preloadFn(), preloadTimeout])
      .then((rows) => {
        clearTimeout(preloadTimeoutId);
        if (debug) console.log(`[useTimeSeriesStream] Preload complete: ${rows.length} rows`);
        seedRows(rows);
      })
      .catch((err) => {
        clearTimeout(preloadTimeoutId);
        console.error('[useTimeSeriesStream] Failed to preload:', err);
        setPreloadError(err instanceof Error ? err : new Error(String(err)));
      });
  }, [preloadFn, debug]);

  // Pending rows accumulated between flushes
  const pendingRef = useRef<TRow[]>([]);

  // Each SSE message queues rows for the next flush; also clears any prior errors (DB recovered).
  // Uses refs to avoid calling setState when errors are already null — those no-op setState calls
  // still enter the reconciler and produce an extra React commit per SSE tick.
  const preloadErrorRef = useRef<Error | null>(null);
  const serviceErrorRef = useRef<Error | null>(null);
  preloadErrorRef.current = preloadError;
  serviceErrorRef.current = serviceError;

  const handleData = useCallback((incoming: TRow[]) => {
    if (debug) {
      console.log(`[useTimeSeriesStream] Received ${incoming.length} rows, queuing for next flush`);
    }
    if (preloadErrorRef.current !== null) setPreloadError(null);
    if (serviceErrorRef.current !== null) setServiceError(null);
    pendingRef.current.push(...incoming);
  }, [debug]);

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

      // Binary search for the eviction boundary - O(log n)
      const cutoffIdx = lowerBound(sorted, cutoff, getTimeRef.current);

      // Remove evicted keys from the dedup set
      for (let i = 0; i < cutoffIdx; i++) {
        dedup.delete(getKeyRef.current(sorted[i]));
      }

      // Build new array: surviving suffix + new rows
      const hasCutoff = cutoffIdx > 0;
      const hasNew = newRows.length > 0;
      let next: TRow[];
      if (!hasCutoff && !hasNew) {
        next = sorted;
      } else if (!hasCutoff) {
        next = [...sorted, ...newRows];
      } else if (!hasNew) {
        next = sorted.slice(cutoffIdx);
      } else {
        next = [...sorted.slice(cutoffIdx), ...newRows];
      }

      sortedRef.current = next;
      setSortedRows(next);
      setHasData(true);
      lastDataTimeRef.current = now;
    }, updateIntervalMs);
    return () => clearInterval(id);
  }, [windowSeconds, updateIntervalMs]);

  // Periodic refresh: keeps the buffer bounded at ~preload size regardless of how long the
  // SSE stream has been running. Without this, a 30-min window accumulates ~1800 raw rows/container.
  useEffect(() => {
    if (!refreshIntervalMs) return;
    const id = setInterval(() => { void doRefreshRef.current(); }, refreshIntervalMs);
    return () => clearInterval(id);
  }, [refreshIntervalMs]);

  // Re-fetch history when tab becomes visible after idle/sleep
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastRefreshRef.current < VISIBILITY_REFRESH_COOLDOWN_MS) return;
      void doRefreshRef.current();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  const onServiceError = useCallback(() => {
    setServiceError(new Error('Database unavailable'));
  }, []);

  const { isConnected, error: sseError } = useEventSource<TRow[]>({
    url: sseUrl,
    onData: handleData,
    onServiceError,
    debug,
  });

  const error = sseError ?? serviceError ?? preloadError;

  const prevLatestRef = useRef<Map<string, TRow>>(new Map());

  const latestByEntity = useMemo(() => {
    const prev = prevLatestRef.current;
    const next = new Map<string, TRow>();

    for (const row of sortedRows) {
      const entity = getEntityRef.current(row);
      const existing = next.get(entity);
      if (!existing || getTimeRef.current(row) > getTimeRef.current(existing)) {
        next.set(entity, row);
      }
    }

    // Structural sharing: return previous Map if nothing changed.
    // Compare by row key (dedup key includes timestamp, so this detects actual data changes).
    if (next.size !== prev.size) {
      prevLatestRef.current = next;
      return next;
    }
    for (const [entity, row] of next) {
      const prevRow = prev.get(entity);
      if (!prevRow || getKeyRef.current(row) !== getKeyRef.current(prevRow)) {
        prevLatestRef.current = next;
        return next;
      }
    }

    return prev;
  }, [sortedRows]);

  // Stale detection via interval — uses lastDataTimeRef (declared above) to
  // avoid tearing down/recreating the interval every time new data arrives.
  const [isStale, setIsStale] = useState(false);
  useEffect(() => {
    if (!hasData) return;
    const id = setInterval(() => {
      const t = lastDataTimeRef.current;
      const stale = t !== null && Date.now() - t > STALE_THRESHOLD_MS;
      setIsStale(prev => prev === stale ? prev : stale);
    }, STALE_CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [hasData]);

  return { rows: sortedRows, latestByEntity, isConnected, error, hasData, isStale };
}
