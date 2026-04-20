import { describe, it, expect } from 'bun:test';
import { lowerBound, mergeWithEviction } from '../../timeSeriesStream/timeWindowTrim';

interface Row {
  time: number;
}

const getTime = (r: Row) => r.time;

describe('lowerBound', () => {
  it('returns 0 for an empty array', () => {
    expect(lowerBound<Row>([], 5, getTime)).toBe(0);
  });

  it('returns 0 when cutoff is less than the first element', () => {
    const arr: Row[] = [{ time: 10 }, { time: 20 }, { time: 30 }];
    expect(lowerBound(arr, 5, getTime)).toBe(0);
  });

  it('returns arr.length when cutoff is greater than all elements', () => {
    const arr: Row[] = [{ time: 10 }, { time: 20 }, { time: 30 }];
    expect(lowerBound(arr, 100, getTime)).toBe(3);
  });

  it('is inclusive at the cutoff (first >= cutoff)', () => {
    const arr: Row[] = [{ time: 10 }, { time: 20 }, { time: 30 }];
    expect(lowerBound(arr, 20, getTime)).toBe(1);
  });

  it('finds the boundary for interior values', () => {
    const arr: Row[] = [{ time: 10 }, { time: 20 }, { time: 30 }, { time: 40 }];
    expect(lowerBound(arr, 25, getTime)).toBe(2);
  });
});

describe('mergeWithEviction', () => {
  it('returns the same reference when nothing changes', () => {
    const sorted: Row[] = [{ time: 10 }, { time: 20 }];
    const result = mergeWithEviction(sorted, [], 5, getTime);
    expect(result.next).toBe(sorted);
    expect(result.cutoffIdx).toBe(0);
  });

  it('evicts rows older than cutoff and returns a new array', () => {
    const sorted: Row[] = [{ time: 1 }, { time: 5 }, { time: 10 }, { time: 20 }];
    const result = mergeWithEviction(sorted, [], 10, getTime);
    expect(result.cutoffIdx).toBe(2);
    expect(result.next).toEqual([{ time: 10 }, { time: 20 }]);
    expect(result.next).not.toBe(sorted);
  });

  it('appends new rows when there is no eviction', () => {
    const sorted: Row[] = [{ time: 10 }, { time: 20 }];
    const newRows: Row[] = [{ time: 25 }, { time: 30 }];
    const result = mergeWithEviction(sorted, newRows, 5, getTime);
    expect(result.cutoffIdx).toBe(0);
    expect(result.next).toEqual([{ time: 10 }, { time: 20 }, { time: 25 }, { time: 30 }]);
  });

  it('evicts and appends in a single pass', () => {
    const sorted: Row[] = [{ time: 1 }, { time: 5 }, { time: 10 }];
    const newRows: Row[] = [{ time: 25 }];
    const result = mergeWithEviction(sorted, newRows, 8, getTime);
    expect(result.cutoffIdx).toBe(2);
    expect(result.next).toEqual([{ time: 10 }, { time: 25 }]);
  });
});
