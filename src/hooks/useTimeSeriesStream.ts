import { useState, useCallback, useEffect, useRef } from 'react';
import { useEventSource } from './useEventSource';
import { useSSEBuffer } from './timeSeriesStream/useSSEBuffer';
import { useVisibilityRefresh } from './timeSeriesStream/useVisibilityRefresh';
import { useLatestByEntity } from './timeSeriesStream/useLatestByEntity';

const STALE_THRESHOLD_MS = 30000;
const STALE_CHECK_INTERVAL_MS = 5000;
const PRELOAD_TIMEOUT_MS = 8000;
export const VISIBILITY_REFRESH_COOLDOWN_MS = 5000;
const STALE_INITIAL_DATA_MS = 1500;

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
 * Provides a time-windowed stream of rows by preloading historical data and merging subsequent SSE updates.
 *
 * Composes sub-hooks from `./timeSeriesStream/`:
 *  - `useSSEBuffer` - sorted buffer + dedup + periodic flush + eviction
 *  - `useVisibilityRefresh` - re-fetch history when tab becomes visible
 *  - `useLatestByEntity` - latest-per-entity Map with structural sharing
 *
 * The orchestrator owns one-time preload, periodic refresh, and stale detection.
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
  // Keep refs up to date for use in callbacks and memoization
  // (callers pass inline arrows - refs give stable identities for useMemo and interval callbacks)
  const getKeyRef = useRef(getKey);
  const getTimeRef = useRef(getTime);
  const getEntityRef = useRef(getEntity);
  const preloadFnRef = useRef(preloadFn);
  getKeyRef.current = getKey;
  getTimeRef.current = getTime;
  getEntityRef.current = getEntity;
  preloadFnRef.current = preloadFn;

  const { sortedRows, hasData, enqueue, replaceBuffer, lastDataTimeRef } = useSSEBuffer<TRow>({
    getKeyRef,
    getTimeRef,
    windowSeconds,
    updateIntervalMs,
  });

  const [preloadError, setPreloadError] = useState<Error | null>(null);
  const [serviceError, setServiceError] = useState<Error | null>(null);
  const [isStale, setIsStale] = useState(false);
  const preloadedRef = useRef(false);

  // Track last refresh time for visibility cooldown (shared with useVisibilityRefresh)
  const lastRefreshRef = useRef(0);

  // Atomic buffer refresh — re-fetches bucketed history and swaps the buffer in one state update.
  // Stored as a ref so effects always invoke the latest closure without recreating intervals.
  const doRefreshRef = useRef<() => Promise<void>>(async () => {});
  doRefreshRef.current = async () => {
    let rows: TRow[];
    try {
      rows = await preloadFnRef.current();
    } catch {
      return; // silently ignore - next interval will retry
    }
    const now = Date.now();
    lastRefreshRef.current = now;
    if (rows.length === 0) return;
    setIsStale(false);
    replaceBuffer(rows, { preserveLiveTail: true });

    if (debug) {
      console.log(`[useTimeSeriesStream] Buffer refresh: ${rows.length} rows`);
    }
  };

  // Seed the buffer from cached initialData or fetch via preloadFn.
  // Re-fetches when preloadFn changes (window size changed via settings).
  const initialDataRef = useRef(initialData);
  initialDataRef.current = initialData;

  useEffect(() => {
    if (preloadedRef.current) {
      // preloadFn changed after initial mount - window size changed, re-fetch history.
      doRefreshRef.current().catch(() => {});
      return;
    }
    preloadedRef.current = true;

    const seedRows = (rows: TRow[]) => {
      if (rows.length === 0) return;
      replaceBuffer(rows, { markHasData: true });
      lastRefreshRef.current = Date.now();
    };

    // Use cached data if available (e.g. from TanStack Query)
    if (initialDataRef.current && initialDataRef.current.length > 0) {
      seedRows(initialDataRef.current);
      // Cached data may be stale (e.g. navigated away and back). If the newest row
      // is behind now, schedule a refresh to fill the gap.
      let maxTime = 0;
      for (const r of initialDataRef.current) {
        const t = getTimeRef.current(r);
        if (t > maxTime) maxTime = t;
      }
      if (maxTime > 0 && Date.now() - maxTime > STALE_INITIAL_DATA_MS) {
        setTimeout(() => { doRefreshRef.current().catch(() => {}); }, 0);
      }
      return;
    }

    // Otherwise fetch from the server
    if (debug) console.log('[useTimeSeriesStream] Starting preload...');
    let preloadTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const preloadTimeout = new Promise<never>((_, reject) => {
      preloadTimeoutId = setTimeout(() => reject(new Error('Database unavailable')), PRELOAD_TIMEOUT_MS);
    });
    Promise.race([preloadFn(), preloadTimeout])
      .then((rows) => {
        if (preloadTimeoutId !== undefined) clearTimeout(preloadTimeoutId);
        if (debug) console.log(`[useTimeSeriesStream] Preload complete: ${rows.length} rows`);
        seedRows(rows);
      })
      .catch((err) => {
        if (preloadTimeoutId !== undefined) clearTimeout(preloadTimeoutId);
        console.error('[useTimeSeriesStream] Failed to preload:', err);
        setPreloadError(err instanceof Error ? err : new Error(String(err)));
      });
  }, [preloadFn, debug, replaceBuffer]);

  // Each SSE message queues rows for the next flush; also clears any prior errors (DB recovered).
  // Uses refs to avoid calling setState when errors are already null — those no-op setState calls
  // still enter the reconciler and produce an extra React commit per SSE tick.
  const preloadErrorRef = useRef<Error | null>(null);
  const serviceErrorRef = useRef<Error | null>(null);
  preloadErrorRef.current = preloadError;
  serviceErrorRef.current = serviceError;

  const handleData = useCallback((incoming: TRow[]) => {
    if (preloadErrorRef.current !== null) setPreloadError(null);
    if (serviceErrorRef.current !== null) setServiceError(null);
    enqueue(incoming);
  }, [enqueue]);

  // Periodic refresh: keeps the buffer bounded at ~preload size regardless of how long the
  // SSE stream has been running. Without this, a 30-min window accumulates ~1800 raw rows/container.
  useEffect(() => {
    if (!refreshIntervalMs) return;
    const id = setInterval(() => { doRefreshRef.current().catch(() => {}); }, refreshIntervalMs);
    return () => clearInterval(id);
  }, [refreshIntervalMs]);

  // Re-fetch history when tab becomes visible after idle/sleep
  useVisibilityRefresh({
    onRefresh: () => { doRefreshRef.current().catch(() => {}); },
    cooldownMs: VISIBILITY_REFRESH_COOLDOWN_MS,
    lastRefreshRef,
  });

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

  const latestByEntity = useLatestByEntity<TRow>({
    rows: sortedRows,
    getEntityRef,
    getTimeRef,
    getKeyRef,
  });

  // Stale detection via interval — uses lastDataTimeRef to
  // avoid tearing down/recreating the interval every time new data arrives.
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
