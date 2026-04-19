import { useMemo, useRef } from 'react';

interface UseLatestByEntityOptions<TRow> {
  rows: TRow[];
  /** Ref-wrapped getters so callers can pass inline arrows without busting memoization. */
  getEntityRef: React.RefObject<(row: TRow) => string>;
  getTimeRef: React.RefObject<(row: TRow) => number>;
  getKeyRef: React.RefObject<(row: TRow) => string>;
}

/**
 * Computes the most recent row per entity from a sorted-rows buffer.
 *
 * Preserves structural sharing: when no entity's latest row has changed (by key), returns the
 * previous Map reference. This lets downstream consumers rely on reference equality to skip work.
 */
export function useLatestByEntity<TRow>({
  rows,
  getEntityRef,
  getTimeRef,
  getKeyRef,
}: UseLatestByEntityOptions<TRow>): Map<string, TRow> {
  const prevLatestRef = useRef<Map<string, TRow>>(new Map());

  return useMemo(() => {
    const prev = prevLatestRef.current;
    const next = new Map<string, TRow>();

    for (const row of rows) {
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
    // getEntityRef/getTimeRef/getKeyRef are stable ref objects; only `rows` drives recomputation.
  }, [rows]);
}
