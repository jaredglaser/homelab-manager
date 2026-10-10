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
export function lowerBound<T>(arr: T[], cutoff: number, getTime: (item: T) => number): number {
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
 * Stable merge of two ascending runs into one ascending array. Rows from `a` win ties.
 */
function mergeSorted<T>(a: T[], b: T[], getTime: (item: T) => number): T[] {
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (getTime(a[i]) <= getTime(b[j])) out.push(a[i++]);
    else out.push(b[j++]);
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

/**
 * Merges a new batch of rows into a sorted buffer while evicting entries older than `cutoff`.
 *
 * Assumes:
 *  - `sorted` is already sorted ascending by time.
 *  - `newRows` is sorted ascending by time and is disjoint from `sorted` (callers deduplicate first).
 *
 * When every entry in `newRows` is at or after the newest surviving entry (the usual live arrival
 * pattern) the batch is appended after O(log n) eviction, keeping the documented O(k log k + log n)
 * flush shape. When a batch predates the buffer tail (an in-flight frame flushed after a preload
 * seed, say) the two runs merge in O(n + k) so the output stays time-sorted and no row is dropped.
 * Returns the same `sorted` reference when there is neither eviction nor new rows to add,
 * preserving referential equality.
 *
 * @returns The new buffer and the index at which eviction began (for dedup-set cleanup).
 */
export function mergeWithEviction<T>(
  sorted: T[],
  newRows: T[],
  cutoff: number,
  getTime: (item: T) => number,
): { next: T[]; cutoffIdx: number } {
  const cutoffIdx = lowerBound(sorted, cutoff, getTime);
  const hasCutoff = cutoffIdx > 0;
  const hasNew = newRows.length > 0;

  const tail = hasCutoff ? sorted.slice(cutoffIdx) : sorted;
  const overlaps = hasNew && tail.length > 0 && getTime(newRows[0]) < getTime(tail[tail.length - 1]);

  let next: T[];
  if (overlaps) {
    next = mergeSorted(tail, newRows, getTime);
  } else if (!hasCutoff && !hasNew) {
    next = sorted;
  } else if (!hasCutoff) {
    next = [...sorted, ...newRows];
  } else if (!hasNew) {
    next = tail;
  } else {
    next = [...tail, ...newRows];
  }

  return { next, cutoffIdx };
}
