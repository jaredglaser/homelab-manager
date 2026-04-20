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
 * Merges a new batch of rows into a sorted buffer while evicting entries older than `cutoff`.
 *
 * Assumes:
 *  - `sorted` is already sorted ascending by time.
 *  - `newRows` is sorted ascending by time and is disjoint from `sorted` (callers deduplicate first).
 *  - Every entry in `newRows` is newer than any surviving entry (typical SSE arrival pattern).
 *
 * O(log n) eviction via binary search + O(k) append. Returns the same `sorted` reference when
 * there is neither eviction nor new rows to add, preserving referential equality.
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

  let next: T[];
  if (!hasCutoff && !hasNew) {
    next = sorted;
  } else if (!hasCutoff) {
    next = [...sorted, ...newRows];
  } else if (!hasNew) {
    next = sorted.slice(cutoffIdx);
  } else {
    next = [...sorted.slice(cutoffIdx), ...newRows];
  }

  return { next, cutoffIdx };
}
