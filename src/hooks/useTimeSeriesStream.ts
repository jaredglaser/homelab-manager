import { useState, useCallback, useEffect, useRef } from 'react';
import { useSSE } from './useSSE';

const STALE_THRESHOLD_MS = 30000;
const STALE_CHECK_INTERVAL_MS = 5000;
const RENDER_INTERVAL_MS = 1000;

interface UseTimeSeriesStreamOptions<TRow> {
  sseUrl: string;
  preloadFn: () => Promise<TRow[]>;
  getKey: (row: TRow) => string;
  getTime: (row: TRow) => number;
  getEntity: (row: TRow) => string;
  windowSeconds?: number; // default 60
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
 */
export function useTimeSeriesStream<TRow>({
  sseUrl,
  preloadFn,
  getKey,
  getTime,
  getEntity,
  windowSeconds = 60,
}: UseTimeSeriesStreamOptions<TRow>): UseTimeSeriesStreamResult<TRow> {
  const [buffer, setBuffer] = useState<Map<string, TRow>>(new Map());
  const [hasData, setHasData] = useState(false);
  const [lastDataTime, setLastDataTime] = useState<number | null>(null);
  const preloadedRef = useRef(false);

  // Preload historical data on mount
  useEffect(() => {
    if (preloadedRef.current) return;
    preloadedRef.current = true;

    preloadFn()
      .then((rows) => {
        if (rows.length === 0) return;
        setBuffer((prev) => {
          const next = new Map(prev);
          for (const row of rows) {
            next.set(getKey(row), row);
          }
          return next;
        });
        setHasData(true);
        setLastDataTime(Date.now());
      })
      .catch((err) => {
        console.error('[useTimeSeriesStream] Failed to preload:', err);
      });
  }, [preloadFn, getKey]);

  // Accumulate incoming SSE rows without triggering renders
  const pendingRef = useRef<TRow[]>([]);
  const getKeyRef = useRef(getKey);
  const getTimeRef = useRef(getTime);
  getKeyRef.current = getKey;
  getTimeRef.current = getTime;

  const handleData = useCallback((incoming: TRow[]) => {
    pendingRef.current.push(...incoming);
  }, []);

  // Flush pending rows into buffer on a fixed interval
  useEffect(() => {
    console.log(`[useTimeSeriesStream] Setting up flush interval with ${RENDER_INTERVAL_MS}ms interval`);
    let lastIntervalTime = Date.now();

    const id = setInterval(() => {
      const now = Date.now();
      const intervalElapsed = now - lastIntervalTime;
      lastIntervalTime = now;

      const pending = pendingRef.current;
      if (pending.length === 0) {
        // Interval is firing correctly, just no data to flush yet
        return;
      }
      pendingRef.current = [];

      const cutoff = now - windowSeconds * 1000;

      console.log(`[useTimeSeriesStream] Flushing ${pending.length} pending rows to buffer at ${new Date(now).toISOString()} (interval fired ${intervalElapsed}ms ago)`);

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
    }, RENDER_INTERVAL_MS);
    return () => {
      console.log('[useTimeSeriesStream] Cleaning up flush interval');
      clearInterval(id);
    };
  }, [windowSeconds]);

  const { isConnected, error } = useSSE<TRow[]>({
    url: sseUrl,
    onData: handleData,
  });

  // Derive sorted rows and latestByEntity from buffer
  const rows = Array.from(buffer.values()).sort(
    (a, b) => getTime(a) - getTime(b),
  );

  const latestByEntity = new Map<string, TRow>();
  for (const row of rows) {
    const entity = getEntity(row);
    const existing = latestByEntity.get(entity);
    if (!existing || getTime(row) > getTime(existing)) {
      latestByEntity.set(entity, row);
    }
  }

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
