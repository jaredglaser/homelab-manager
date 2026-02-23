import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useSSE } from './useSSE';

const STALE_THRESHOLD_MS = 30000;
const STALE_CHECK_INTERVAL_MS = 5000;

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

/**
 * Unified hook: preloads historical data, then merges SSE updates.
 * Maintains a time-windowed buffer and a latest-per-entity map.
 * Server controls the update cadence (1s poll); each SSE message = one render.
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
  const [buffer, setBuffer] = useState<Map<string, TRow>>(new Map());
  const [hasData, setHasData] = useState(false);
  const [lastDataTime, setLastDataTime] = useState<number | null>(null);
  const preloadedRef = useRef(false);

  // Keep refs up to date for use in callbacks
  const getKeyRef = useRef(getKey);
  const getTimeRef = useRef(getTime);
  getKeyRef.current = getKey;
  getTimeRef.current = getTime;

  // Preload historical data on mount
  useEffect(() => {
    if (preloadedRef.current) return;
    preloadedRef.current = true;

    if (debug) console.log('[useTimeSeriesStream] Starting preload...');
    preloadFn()
      .then((rows) => {
        if (rows.length === 0) {
          if (debug) console.log('[useTimeSeriesStream] Preload complete: 0 rows');
          return;
        }
        if (debug) console.log(`[useTimeSeriesStream] Preload complete: ${rows.length} rows`);
        setBuffer((prev) => {
          const next = new Map(prev);
          for (const row of rows) {
            next.set(getKeyRef.current(row), row);
          }
          return next;
        });
        setHasData(true);
        setLastDataTime(Date.now());
      })
      .catch((err) => {
        console.error('[useTimeSeriesStream] Failed to preload:', err);
      });
  }, [preloadFn, debug]);

  // Pending rows accumulated between flushes
  const pendingRef = useRef<TRow[]>([]);

  // Each SSE message queues rows for the next flush
  const handleData = useCallback((incoming: TRow[]) => {
    if (debug) {
      console.log(`[useTimeSeriesStream] Received ${incoming.length} rows, queuing for next flush`);
    }
    pendingRef.current = pendingRef.current.concat(incoming);
  }, [debug]);

  // Flush pending rows into buffer on a fixed interval
  useEffect(() => {
    const id = setInterval(() => {
      const pending = pendingRef.current;
      if (pending.length === 0) return;
      pendingRef.current = [];

      const now = Date.now();
      const cutoff = now - windowSeconds * 1000;

      setBuffer((prev) => {
        const next = new Map(prev);
        for (const row of pending) {
          next.set(getKeyRef.current(row), row);
        }
        for (const [key, row] of next) {
          if (getTimeRef.current(row) < cutoff) {
            next.delete(key);
          }
        }
        return next;
      });
      setHasData(true);
      setLastDataTime(now);
    }, updateIntervalMs);
    return () => clearInterval(id);
  }, [windowSeconds, updateIntervalMs]);

  const { isConnected, error } = useSSE<TRow[]>({
    url: sseUrl,
    onData: handleData,
    debug,
  });

  // Derive sorted rows and latestByEntity from buffer (memoized to avoid
  // recomputing on unrelated re-renders like isConnected/isStale changes)
  const rows = useMemo(
    () => Array.from(buffer.values()).sort((a, b) => getTime(a) - getTime(b)),
    [buffer, getTime],
  );

  const latestByEntity = useMemo(() => {
    const map = new Map<string, TRow>();
    for (const row of rows) {
      const entity = getEntity(row);
      const existing = map.get(entity);
      if (!existing || getTime(row) > getTime(existing)) {
        map.set(entity, row);
      }
    }
    return map;
  }, [rows, getEntity, getTime]);

  // Stale detection via interval
  const [isStale, setIsStale] = useState(false);
  useEffect(() => {
    if (!hasData) return;
    const id = setInterval(() => {
      setIsStale(lastDataTime !== null && Date.now() - lastDataTime > STALE_THRESHOLD_MS);
    }, STALE_CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [hasData, lastDataTime]);

  return { rows, latestByEntity, isConnected, error, hasData, isStale };
}
