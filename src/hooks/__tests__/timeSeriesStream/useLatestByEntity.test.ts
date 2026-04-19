import { describe, it, expect } from 'bun:test';
import { useRef } from 'react';
import { renderHook } from '@testing-library/react';
import { useLatestByEntity } from '../../timeSeriesStream/useLatestByEntity';

interface Row {
  key: string;
  time: number;
  entity: string;
}

function renderLatest(rows: Row[]) {
  return renderHook(
    ({ rs }: { rs: Row[] }) => {
      const getKeyRef = useRef((r: Row) => r.key);
      const getTimeRef = useRef((r: Row) => r.time);
      const getEntityRef = useRef((r: Row) => r.entity);
      return useLatestByEntity<Row>({ rows: rs, getEntityRef, getTimeRef, getKeyRef });
    },
    { initialProps: { rs: rows } },
  );
}

describe('useLatestByEntity', () => {
  it('computes the latest row per entity', () => {
    const rows: Row[] = [
      { key: 'a-1', time: 1, entity: 'a' },
      { key: 'a-2', time: 3, entity: 'a' },
      { key: 'b-1', time: 2, entity: 'b' },
    ];
    const { result } = renderLatest(rows);
    expect(result.current.size).toBe(2);
    expect(result.current.get('a')?.key).toBe('a-2');
    expect(result.current.get('b')?.key).toBe('b-1');
  });

  it('returns the same Map reference when no entity latest changes (duplicate keys)', () => {
    const rows1: Row[] = [
      { key: 'a-1', time: 1, entity: 'a' },
      { key: 'b-1', time: 2, entity: 'b' },
    ];
    const rows2: Row[] = [
      { key: 'a-1', time: 1, entity: 'a' }, // same latest for 'a'
      { key: 'b-1', time: 2, entity: 'b' }, // same latest for 'b'
    ];
    const { result, rerender } = renderLatest(rows1);
    const first = result.current;
    rerender({ rs: rows2 });
    expect(result.current).toBe(first);
  });

  it('returns a new Map when an entity gets a newer row', () => {
    const bRow = { key: 'b-1', time: 2, entity: 'b' };
    const rows1: Row[] = [
      { key: 'a-1', time: 1, entity: 'a' },
      bRow,
    ];
    const rows2: Row[] = [
      { key: 'a-1', time: 1, entity: 'a' },
      bRow,
      { key: 'a-2', time: 5, entity: 'a' },
    ];
    const { result, rerender } = renderLatest(rows1);
    const first = result.current;
    rerender({ rs: rows2 });
    expect(result.current).not.toBe(first);
    expect(result.current.get('a')?.key).toBe('a-2');
    // Entity 'b' row reference is preserved when the source row object is the same.
    expect(result.current.get('b')).toBe(first.get('b'));
  });

  it('returns a new Map when the number of entities changes', () => {
    const rows1: Row[] = [{ key: 'a-1', time: 1, entity: 'a' }];
    const rows2: Row[] = [
      { key: 'a-1', time: 1, entity: 'a' },
      { key: 'c-1', time: 2, entity: 'c' },
    ];
    const { result, rerender } = renderLatest(rows1);
    const first = result.current;
    rerender({ rs: rows2 });
    expect(result.current).not.toBe(first);
    expect(result.current.size).toBe(2);
  });

  it('returns a new Map when an existing entity is replaced by a different-key row of same count', () => {
    const rows1: Row[] = [
      { key: 'a-1', time: 1, entity: 'a' },
      { key: 'b-1', time: 2, entity: 'b' },
    ];
    // Same two entities but entity 'a' gets a replacement row (e.g. windowing evicted 'a-1' and a new 'a-2' arrived).
    const rows2: Row[] = [
      { key: 'a-2', time: 3, entity: 'a' },
      { key: 'b-1', time: 2, entity: 'b' },
    ];
    const { result, rerender } = renderLatest(rows1);
    const first = result.current;
    rerender({ rs: rows2 });
    expect(result.current).not.toBe(first);
    expect(result.current.get('a')?.key).toBe('a-2');
  });

  it('returns a new Map when a same-size set has a different entity (prev entity dropped)', () => {
    const rows1: Row[] = [
      { key: 'a-1', time: 1, entity: 'a' },
      { key: 'b-1', time: 2, entity: 'b' },
    ];
    // same count, but 'b' dropped and 'c' added — prev has no row for 'c'
    const rows2: Row[] = [
      { key: 'a-1', time: 1, entity: 'a' },
      { key: 'c-1', time: 3, entity: 'c' },
    ];
    const { result, rerender } = renderLatest(rows1);
    const first = result.current;
    rerender({ rs: rows2 });
    expect(result.current).not.toBe(first);
    expect(result.current.has('c')).toBe(true);
    expect(result.current.has('b')).toBe(false);
  });
});
