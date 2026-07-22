import { useState, useCallback, useEffect, useRef } from 'react';
import { useEventSource } from './useEventSource';
import { useSSEBuffer } from './timeSeriesStream/useSSEBuffer';
import { useVisibilityRefresh } from './timeSeriesStream/useVisibilityRefresh';
import { useLatestByEntity } from './timeSeriesStream/useLatestByEntity';
import type { RowAccessors } from './timeSeriesStream/types';

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
  windowSeconds?: number;
  updateIntervalMs?: number;
  refreshIntervalMs?: number;
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
 * Time-windowed stream that preloads historical rows and merges subsequent SSE updates.
 * Composes the buffer, visibility refresh, and latest-by-entity sub-hooks; owns preload,
 * periodic refresh, and stale detection.
 *
 * @param options.sseUrl - SSE endpoint emitting incremental rows as JSON arrays.
 * @param options.preloadFn - Fetches historical rows (e.g. bucketed history) to seed the buffer.
 * @param options.getKey - Row key used for dedup against preload/SSE overlap.
 * @param options.getTime - Row timestamp (ms epoch); drives sort and eviction.
 * @param options.getEntity - Entity identifier driving the `latestByEntity` map.
 * @param options.windowSeconds - Retention window in seconds; rows beyond it are evicted (default 60).
 * @param options.updateIntervalMs - SSE flush cadence in ms (default 1000).
 * @param options.refreshIntervalMs - If set, periodic re-preload cadence in ms; keeps long-lived buffers bounded.
 * @param options.initialData - Cached preload (e.g. TanStack Query) for synchronous seed; refetched if older than ~1.5s.
 * @param options.debug - Logs preload and refresh activity.
 *
 * @returns Stream state:
 *   - `rows`: sorted ascending by time, within the window
 *   - `latestByEntity`: latest row per entity, structurally shared so reference equality skips work downstream
 *   - `isConnected`: SSE socket state
 *   - `error`: composed in preference order (sseError, then serviceError, then preloadError)
 *   - `hasData`: true after the first seed or SSE flush
 *   - `isStale`: true when no data has arrived for ~30s
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
  const accessorsRef = useRef<RowAccessors<TRow>>({ key: getKey, time: getTime, entity: getEntity });
  accessorsRef.current = { key: getKey, time: getTime, entity: getEntity };

  const preloadFnRef = useRef(preloadFn);
  preloadFnRef.current = preloadFn;

  const { sortedRows, hasData, enqueue, replaceBuffer, getLastDataTime, resetFirstFlush } = useSSEBuffer<TRow, RowAccessors<TRow>>({
    accessorsRef,
    windowSeconds,
    updateIntervalMs,
  });

  const [preloadError, setPreloadError] = useState<Error | null>(null);
  const [serviceError, setServiceError] = useState<Error | null>(null);
  const [isStale, setIsStale] = useState(false);
  const preloadedRef = useRef(false);

  // Shared cooldown clock across preload, periodic refresh, and visibility refresh.
  const lastRefreshRef = useRef(0);

  const doRefreshRef = useRef<() => Promise<void>>(async () => {});
  doRefreshRef.current = async () => {
    let rows: TRow[];
    try {
      rows = await preloadFnRef.current();
    } catch {
      return; // caller will retry on the next interval / visibility event
    }
    const now = Date.now();
    lastRefreshRef.current = now;
    if (rows.length === 0) return;
    setIsStale(false);
    const stats = replaceBuffer(rows, { mode: 'refresh', preserveLiveTail: true });

    if (debug) {
      console.log(
        `[useTimeSeriesStream] Buffer refresh: ${stats.bucketed} bucketed + ${stats.liveTail} live = ${stats.total} total`,
      );
    }
  };

  const initialDataRef = useRef(initialData);
  initialDataRef.current = initialData;

  useEffect(() => {
    if (preloadedRef.current) {
      // preloadFn changed after initial mount (window size changed) - re-fetch history.
      doRefreshRef.current().catch(() => {});
      return;
    }
    preloadedRef.current = true;

    const seedRows = (rows: TRow[]) => {
      if (rows.length === 0) return;
      replaceBuffer(rows, { mode: 'seed' });
      lastRefreshRef.current = Date.now();
    };

    if (initialDataRef.current && initialDataRef.current.length > 0) {
      seedRows(initialDataRef.current);
      // Cached data may be stale (e.g. navigated away and back). If the newest row
      // is behind now, schedule a refresh to fill the gap.
      let maxTime = 0;
      for (const r of initialDataRef.current) {
        const t = accessorsRef.current.time(r);
        if (t > maxTime) maxTime = t;
      }
      if (maxTime > 0 && Date.now() - maxTime > STALE_INITIAL_DATA_MS) {
        setTimeout(() => { doRefreshRef.current().catch(() => {}); }, 0);
      }
      return;
    }

    if (debug) console.log('[useTimeSeriesStream] Starting preload...');
    let preloadTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const preloadTimeout = new Promise<never>((_, reject) => {
      preloadTimeoutId = setTimeout(() => reject(new Error('Database unavailable')), PRELOAD_TIMEOUT_MS);
    });
    Promise.race([preloadFnRef.current(), preloadTimeout])
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

  const preloadErrorRef = useRef<Error | null>(null);
  const serviceErrorRef = useRef<Error | null>(null);
  preloadErrorRef.current = preloadError;
  serviceErrorRef.current = serviceError;

  const handleData = useCallback((incoming: TRow[]) => {
    if (preloadErrorRef.current !== null) setPreloadError(null);
    if (serviceErrorRef.current !== null) setServiceError(null);
    enqueue(incoming);
  }, [enqueue]);

  // Keeps the buffer bounded at ~preload size regardless of how long the SSE stream has been running.
  // Without this, a 30-min window accumulates ~1800 raw rows/container.
  useEffect(() => {
    if (!refreshIntervalMs) return;
    const id = setInterval(() => { doRefreshRef.current().catch(() => {}); }, refreshIntervalMs);
    return () => clearInterval(id);
  }, [refreshIntervalMs]);

  useVisibilityRefresh({
    onRefresh: () => { doRefreshRef.current().catch(() => {}); },
    cooldownMs: VISIBILITY_REFRESH_COOLDOWN_MS,
    lastRefreshRef,
  });

  const onServiceError = useCallback(() => {
    setServiceError(new Error('Database unavailable'));
  }, []);

  // SSE carries snapshots without Last-Event-ID replay, so rows emitted while the
  // connection was down are lost. Re-preload on reconnect to heal the gap instead
  // of waiting for the periodic refresh or a visibility change (up to a minute).
  const onReconnect = useCallback(() => {
    // Re-arm the buffer's first-flush gate before any post-reconnect frame lands
    // (onReconnect fires in onopen, ahead of onmessage) so the first frame paints
    // immediately even when the cooldown below skips the re-preload.
    resetFirstFlush();
    if (Date.now() - lastRefreshRef.current < VISIBILITY_REFRESH_COOLDOWN_MS) return;
    doRefreshRef.current().catch(() => {});
  }, [resetFirstFlush]);

  const { isConnected, error: sseError } = useEventSource<TRow[]>({
    url: sseUrl,
    onData: handleData,
    onServiceError,
    onReconnect,
    debug,
  });

  const error = sseError ?? serviceError ?? preloadError;

  const latestByEntity = useLatestByEntity<TRow>({
    rows: sortedRows,
    accessorsRef,
  });

  useEffect(() => {
    if (!hasData) return;
    const id = setInterval(() => {
      const t = getLastDataTime();
      const stale = t !== null && Date.now() - t > STALE_THRESHOLD_MS;
      setIsStale(prev => prev === stale ? prev : stale);
    }, STALE_CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [hasData, getLastDataTime]);

  return { rows: sortedRows, latestByEntity, isConnected, error, hasData, isStale };
}
