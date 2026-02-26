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
    const preloadTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Database unavailable')), PRELOAD_TIMEOUT_MS)
    );
    Promise.race([preloadFn(), preloadTimeout])
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

  // Derive sorted rows and latestByEntity from buffer
  // Uses refs for callbacks so memos only recompute when buffer actually changes
  // (callers pass inline arrows whose identity changes every render)
  const rows = useMemo(
    () => Array.from(buffer.values()).sort((a, b) => getTimeRef.current(a) - getTimeRef.current(b)),
    [buffer],
  );

  const latestByEntity = useMemo(() => {
    const map = new Map<string, TRow>();
    for (const row of rows) {
      const entity = getEntityRef.current(row);
      const existing = map.get(entity);
      if (!existing || getTimeRef.current(row) > getTimeRef.current(existing)) {
        map.set(entity, row);
      }
    }
    return map;
  }, [rows]);

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

  return { rows, latestByEntity, isConnected, error, hasData, isStale };
}
