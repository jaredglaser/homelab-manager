import { useMemo, useRef } from 'react';
import type { RowAccessors } from './types';

interface UseLatestByEntityOptions<
  TRow,
  TKey extends PropertyKey,
  TEntity extends PropertyKey,
> {
  rows: TRow[];
  accessorsRef: React.RefObject<RowAccessors<TRow, TKey, TEntity>>;
}

/**
 * Latest row per entity, with structural sharing: returns the previous Map reference
 * when no entity's latest row changed (by key) so downstream consumers can short-circuit
 * via reference equality.
 */
export function useLatestByEntity<
  TRow,
  TKey extends PropertyKey = string,
  TEntity extends PropertyKey = string,
>({
  rows,
  accessorsRef,
}: UseLatestByEntityOptions<TRow, TKey, TEntity>): Map<TEntity, TRow> {
  const prevLatestRef = useRef<Map<TEntity, TRow>>(new Map());

  return useMemo(() => {
    const prev = prevLatestRef.current;
    const next = new Map<TEntity, TRow>();
    const { entity, time, key } = accessorsRef.current;

    for (const row of rows) {
      const e = entity(row);
      const existing = next.get(e);
      if (!existing || time(row) > time(existing)) {
        next.set(e, row);
      }
    }

    if (next.size !== prev.size) {
      prevLatestRef.current = next;
      return next;
    }
    for (const [e, row] of next) {
      const prevRow = prev.get(e);
      if (!prevRow || key(row) !== key(prevRow)) {
        prevLatestRef.current = next;
        return next;
      }
    }

    return prev;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
}
