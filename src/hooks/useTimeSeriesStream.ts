import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useSSE } from './useSSE';

const STALE_THRESHOLD_MS = 30000;
const STALE_CHECK_INTERVAL_MS = 5000;
const PRELOAD_TIMEOUT_MS = 8000;

interface UseTimeSeriesStreamOptions<TRow> {
  sseUrl: string;
  preloadFn: () => Promise<TRow[]>;
  getKey: (row: TRow) => string;
  getTime: (row: TRow) => number;
  getEntity: (row: TRow) => string;
  windowSeconds?: number; // default 60
  updateIntervalMs?: number; // default 1000
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

// Returns the index of the first element with getTime(el) >= cutoff (O(log n))
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
  debug = false,
}: UseTimeSeriesStreamOptions<TRow>): UseTimeSeriesStreamResult<TRow> {
  // Primary sorted state — drives renders. sortedRef mirrors it for synchronous reads in the flush interval.
  const [sortedRows, setSortedRows] = useState<TRow[]>([]);
  const sortedRef = useRef<TRow[]>([]);
  // Dedup set: O(1) key lookup prevents duplicate entries from preload/SSE overlap
  const dedupRef = useRef<Set<string>>(new Set());

  const [hasData, setHasData] = useState(false);
  const [lastDataTime, setLastDataTime] = useState<number | null>(null);
  const [preloadError, setPreloadError] = useState<Error | null>(null);
  const [serviceError, setServiceError] = useState<Error | null>(null);
  const preloadedRef = useRef(false);

  // Keep refs up to date for use in callbacks and memoization
  // (callers pass inline arrows — refs give stable identities for useMemo)
  const getKeyRef = useRef(getKey);
  const getTimeRef = useRef(getTime);
  const getEntityRef = useRef(getEntity);
  getKeyRef.current = getKey;
  getTimeRef.current = getTime;
  getEntityRef.current = getEntity;

  // Preload historical data on mount
  useEffect(() => {
    if (preloadedRef.current) return;
    preloadedRef.current = true;

    if (debug) console.log('[useTimeSeriesStream] Starting preload...');
    let preloadTimeoutId: ReturnType<typeof setTimeout>;
    const preloadTimeout = new Promise<never>((_, reject) => {
      preloadTimeoutId = setTimeout(() => reject(new Error('Database unavailable')), PRELOAD_TIMEOUT_MS);
    });
    Promise.race([preloadFn(), preloadTimeout])
      .then((rows) => {
        clearTimeout(preloadTimeoutId);
        if (rows.length === 0) {
          if (debug) console.log('[useTimeSeriesStream] Preload complete: 0 rows');
          return;
        }
        if (debug) console.log(`[useTimeSeriesStream] Preload complete: ${rows.length} rows`);
        const sorted = [...rows].sort((a, b) => getTimeRef.current(a) - getTimeRef.current(b));
        const dedup = dedupRef.current;
        for (const row of sorted) {
          dedup.add(getKeyRef.current(row));
        }
        sortedRef.current = sorted;
        setSortedRows(sorted);
        setHasData(true);
        setLastDataTime(Date.now());
      })
      .catch((err) => {
        clearTimeout(preloadTimeoutId);
        console.error('[useTimeSeriesStream] Failed to preload:', err);
        setPreloadError(err instanceof Error ? err : new Error(String(err)));
      });
  }, [preloadFn, debug]);

  // Pending rows accumulated between flushes
  const pendingRef = useRef<TRow[]>([]);

  // Each SSE message queues rows for the next flush; also clears any prior errors (DB recovered)
  const handleData = useCallback((incoming: TRow[]) => {
    if (debug) {
      console.log(`[useTimeSeriesStream] Received ${incoming.length} rows, queuing for next flush`);
    }
    setPreloadError(null);
    setServiceError(null);
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

      // Filter to new unique rows only — skips preload/SSE overlap duplicates
      const newRows: TRow[] = [];
      for (const row of pending) {
        const key = getKeyRef.current(row);
        if (!dedup.has(key)) {
          dedup.add(key);
          newRows.push(row);
        }
      }

      // Sort the incoming batch (small — typically one per container per second)
      newRows.sort((a, b) => getTimeRef.current(a) - getTimeRef.current(b));

      // Binary search for the eviction boundary — O(log n)
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
      setLastDataTime(now);
    }, updateIntervalMs);
    return () => clearInterval(id);
  }, [windowSeconds, updateIntervalMs]);

  const onServiceError = useCallback(() => {
    setServiceError(new Error('Database unavailable'));
  }, []);

  const { isConnected, error: sseError } = useSSE<TRow[]>({
    url: sseUrl,
    onData: handleData,
    onServiceError,
    debug,
  });

  const error = sseError ?? serviceError ?? preloadError;

  const latestByEntity = useMemo(() => {
    const map = new Map<string, TRow>();
    for (const row of sortedRows) {
      const entity = getEntityRef.current(row);
      const existing = map.get(entity);
      if (!existing || getTimeRef.current(row) > getTimeRef.current(existing)) {
        map.set(entity, row);
      }
    }
    return map;
  }, [sortedRows]);

  // Stale detection via interval
  const [isStale, setIsStale] = useState(false);
  useEffect(() => {
    if (!hasData) return;
    setIsStale(false); // Clear stale immediately when new data arrives
    const id = setInterval(() => {
      setIsStale(lastDataTime !== null && Date.now() - lastDataTime > STALE_THRESHOLD_MS);
    }, STALE_CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [hasData, lastDataTime]);

  return { rows: sortedRows, latestByEntity, isConnected, error, hasData, isStale };
}
