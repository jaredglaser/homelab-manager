import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { useRef } from 'react';
import { renderHook, act } from '@testing-library/react';
import { useSSEBuffer } from '../../timeSeriesStream/useSSEBuffer';
import type { RowAccessors } from '../../timeSeriesStream/types';

interface Row {
  key: string;
  time: number;
  entity: string;
}

const defaultAccessors: RowAccessors<Row> = {
  key: r => r.key,
  time: r => r.time,
  entity: r => r.entity,
};

/** Captured flush callback from the hook's setInterval, invoked manually to advance the timer. */
let flushTick: (() => void) | null = null;

function renderBuffer(windowSeconds = 60, updateIntervalMs = 30) {
  return renderHook(() => {
    const accessorsRef = useRef<RowAccessors<Row>>(defaultAccessors);
    return useSSEBuffer<Row, RowAccessors<Row>>({ accessorsRef, windowSeconds, updateIntervalMs });
  });
}

describe('useSSEBuffer', () => {
  let setIntervalSpy: ReturnType<typeof spyOn>;
  let setTimeoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    flushTick = null;
    setIntervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(
      ((fn: () => void) => {
        flushTick = fn;
        return 0;
      }) as unknown as typeof setInterval
    );
    setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout
    );
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    setTimeoutSpy.mockRestore();
  });

  it('starts empty with hasData=false', () => {
    const { result } = renderBuffer();
    expect(result.current.sortedRows).toEqual([]);
    expect(result.current.hasData).toBe(false);
  });

  it('seed mode sorts rows and marks hasData', () => {
    const { result } = renderBuffer();
    const now = Date.now();
    const rows: Row[] = [
      { key: 'b', time: now - 1000, entity: 'e' },
      { key: 'a', time: now - 5000, entity: 'e' },
    ];
    act(() => { result.current.replaceBuffer(rows, { mode: 'seed' }); });
    expect(result.current.sortedRows.map(r => r.key)).toEqual(['a', 'b']);
    expect(result.current.hasData).toBe(true);
    expect(result.current.getLastDataTime()).not.toBeNull();
  });

  it('refresh mode updates rows but leaves hasData false', () => {
    const { result } = renderBuffer();
    const now = Date.now();
    act(() => { result.current.replaceBuffer([{ key: 'a', time: now, entity: 'e' }], { mode: 'refresh' }); });
    expect(result.current.sortedRows).toHaveLength(1);
    expect(result.current.hasData).toBe(false);
  });

  it('replaceBuffer is a no-op when rows is empty', () => {
    const { result } = renderBuffer();
    act(() => { result.current.replaceBuffer([], { mode: 'seed' }); });
    expect(result.current.sortedRows).toHaveLength(0);
    expect(result.current.hasData).toBe(false);
    expect(result.current.getLastDataTime()).toBeNull();
  });

  it('refresh returns zero-count stats for empty input', () => {
    const { result } = renderBuffer();
    let stats = { bucketed: -1, liveTail: -1, total: -1 };
    act(() => { stats = result.current.replaceBuffer([], { mode: 'refresh' }); });
    expect(stats).toEqual({ bucketed: 0, liveTail: 0, total: 0 });
  });

  it('refresh with preserveLiveTail stitches newer rows beyond the snapshot', () => {
    const { result } = renderBuffer(60, 30);
    const now = Date.now();

    act(() => { result.current.replaceBuffer([{ key: 'a', time: now - 2000, entity: 'e' }], { mode: 'seed' }); });

    act(() => result.current.enqueue([{ key: 'live', time: now + 500, entity: 'e' }]));
    act(() => { flushTick?.(); });
    expect(result.current.sortedRows.map(r => r.key)).toContain('live');

    let stats = { bucketed: -1, liveTail: -1, total: -1 };
    act(() => {
      stats = result.current.replaceBuffer(
        [{ key: 'a', time: now - 1000, entity: 'e' }],
        { mode: 'refresh', preserveLiveTail: true },
      );
    });
    expect(result.current.sortedRows.map(r => r.key)).toEqual(['a', 'live']);
    expect(stats).toEqual({ bucketed: 1, liveTail: 1, total: 2 });
  });

  it('refresh drops live-tail rows whose time is <= preloadMaxTime', () => {
    const { result } = renderBuffer(60, 30);
    const now = Date.now();

    act(() => { result.current.replaceBuffer([{ key: 'a', time: now - 2000, entity: 'e' }], { mode: 'seed' }); });
    // 'stale' is at time now - 1000, which is OLDER than the refresh snapshot's max (now).
    act(() => result.current.enqueue([{ key: 'stale', time: now - 1000, entity: 'e' }]));
    act(() => { flushTick?.(); });

    let stats = { bucketed: -1, liveTail: -1, total: -1 };
    act(() => {
      stats = result.current.replaceBuffer(
        [{ key: 'fresh', time: now, entity: 'e' }],
        { mode: 'refresh', preserveLiveTail: true },
      );
    });
    // 'stale' (time = now-1000) is <= preloadMaxTime (time = now) → must be dropped
    expect(result.current.sortedRows.map(r => r.key)).toEqual(['fresh']);
    expect(stats).toEqual({ bucketed: 1, liveTail: 0, total: 1 });
  });

  it('refresh stitches multiple live-tail rows in sorted order', () => {
    const { result } = renderBuffer(60, 30);
    const now = Date.now();

    act(() => { result.current.replaceBuffer([{ key: 'a', time: now - 5000, entity: 'e' }], { mode: 'seed' }); });
    // Two live-tail rows, enqueued in non-sorted arrival order
    act(() => result.current.enqueue([
      { key: 'live-late', time: now + 2000, entity: 'e' },
      { key: 'live-early', time: now + 1000, entity: 'e' },
    ]));
    act(() => { flushTick?.(); });

    act(() => {
      result.current.replaceBuffer(
        [{ key: 'b', time: now, entity: 'e' }],
        { mode: 'refresh', preserveLiveTail: true },
      );
    });
    // Buffer must be time-sorted: b (now), live-early (now+1000), live-late (now+2000)
    expect(result.current.sortedRows.map(r => r.key)).toEqual(['b', 'live-early', 'live-late']);
  });

  it('refresh with preserveLiveTail over an empty buffer is a clean replace', () => {
    const { result } = renderBuffer(60, 30);
    const now = Date.now();

    let stats = { bucketed: -1, liveTail: -1, total: -1 };
    act(() => {
      stats = result.current.replaceBuffer(
        [{ key: 'x', time: now, entity: 'e' }],
        { mode: 'refresh', preserveLiveTail: true },
      );
    });
    expect(result.current.sortedRows.map(r => r.key)).toEqual(['x']);
    expect(stats).toEqual({ bucketed: 1, liveTail: 0, total: 1 });
  });

  it('first enqueue flushes immediately without waiting for the interval', () => {
    const { result } = renderBuffer(60, 30);
    const now = Date.now();

    // No flushTick call: the first frame after connect must paint on its own.
    act(() => result.current.enqueue([{ key: 'first', time: now, entity: 'e' }]));

    expect(result.current.sortedRows.map(r => r.key)).toEqual(['first']);
    expect(result.current.hasData).toBe(true);
  });

  it('subsequent enqueues batch until the interval fires', () => {
    const { result } = renderBuffer(60, 30);
    const now = Date.now();

    act(() => result.current.enqueue([{ key: 'first', time: now - 1000, entity: 'e' }]));
    act(() => result.current.enqueue([{ key: 'second', time: now, entity: 'e' }]));

    // Second frame stays pending until the periodic flush.
    expect(result.current.sortedRows.map(r => r.key)).toEqual(['first']);

    act(() => { flushTick?.(); });
    expect(result.current.sortedRows.map(r => r.key)).toEqual(['first', 'second']);
  });

  it('enqueue + periodic flush deduplicates against existing rows', () => {
    const { result } = renderBuffer(60, 30);
    const now = Date.now();
    act(() => { result.current.replaceBuffer([{ key: 'a', time: now - 1000, entity: 'e' }], { mode: 'seed' }); });

    act(() => result.current.enqueue([
      { key: 'a', time: now - 1000, entity: 'e' },
      { key: 'b', time: now - 500, entity: 'e' },
    ]));
    act(() => { flushTick?.(); });

    expect(result.current.sortedRows.map(r => r.key)).toEqual(['a', 'b']);
  });

  it('evicted keys are removed from the dedup set so re-enqueues succeed', () => {
    const { result } = renderBuffer(60, 30);
    const now = Date.now();
    act(() => {
      result.current.replaceBuffer(
        [
          { key: 'recycled', time: now - 120_000, entity: 'e' }, // outside 60s window
          { key: 'recent', time: now - 5000, entity: 'e' },
        ],
        { mode: 'seed' },
      );
    });

    // Flush once to trigger the cutoff path that evicts 'recycled' from the dedup set.
    act(() => result.current.enqueue([{ key: 'new', time: now, entity: 'e' }]));
    act(() => { flushTick?.(); });
    expect(result.current.sortedRows.map(r => r.key)).not.toContain('recycled');

    // Now enqueue a row reusing the evicted key. If dedup cleanup worked, it's accepted.
    act(() => result.current.enqueue([{ key: 'recycled', time: now + 100, entity: 'e' }]));
    act(() => { flushTick?.(); });
    const keys = result.current.sortedRows.map(r => r.key);
    expect(keys).toContain('recycled');
  });

  it('flush evicts rows older than the window', () => {
    const { result } = renderBuffer(60, 30);
    const now = Date.now();
    act(() => {
      result.current.replaceBuffer(
        [
          { key: 'old', time: now - 120_000, entity: 'e' },
          { key: 'recent', time: now - 5000, entity: 'e' },
        ],
        { mode: 'seed' },
      );
    });

    act(() => result.current.enqueue([{ key: 'new', time: now, entity: 'e' }]));
    act(() => { flushTick?.(); });

    const keys = result.current.sortedRows.map(r => r.key);
    expect(keys).not.toContain('old');
    expect(keys).toContain('recent');
    expect(keys).toContain('new');
  });

  it('flush with only duplicate pending rows still evicts (cutoff-only branch)', () => {
    const { result } = renderBuffer(60, 30);
    const now = Date.now();
    act(() => {
      result.current.replaceBuffer(
        [
          { key: 'old', time: now - 120_000, entity: 'e' },
          { key: 'recent', time: now - 5000, entity: 'e' },
        ],
        { mode: 'seed' },
      );
    });

    act(() => result.current.enqueue([{ key: 'recent', time: now - 5000, entity: 'e' }]));
    act(() => { flushTick?.(); });

    const keys = result.current.sortedRows.map(r => r.key);
    expect(keys).not.toContain('old');
    expect(keys).toContain('recent');
  });

  it('flush does nothing when the pending queue is empty', () => {
    const { result } = renderBuffer(60, 30);
    const now = Date.now();
    act(() => { result.current.replaceBuffer([{ key: 'a', time: now - 1000, entity: 'e' }], { mode: 'seed' }); });
    const beforeKeys = result.current.sortedRows.map(r => r.key);
    act(() => { flushTick?.(); });
    // Buffer contents unchanged; flush skipped because no pending rows.
    expect(result.current.sortedRows.map(r => r.key)).toEqual(beforeKeys);
  });

  it('flush sets hasData=true when rows flush in', () => {
    const { result } = renderBuffer(60, 30);
    const now = Date.now();
    expect(result.current.hasData).toBe(false);
    act(() => result.current.enqueue([{ key: 'a', time: now, entity: 'e' }]));
    act(() => { flushTick?.(); });
    expect(result.current.hasData).toBe(true);
  });

  it('replaceBuffer rebuilds dedup so pending rows with obsolete keys get through', () => {
    const { result } = renderBuffer(60, 30);
    const now = Date.now();

    // Seed with 'a' so it's in the dedup set.
    act(() => { result.current.replaceBuffer([{ key: 'a', time: now - 5000, entity: 'e' }], { mode: 'seed' }); });

    // Enqueue a NEW row (key 'b') and then refresh with a snapshot that contains only 'c'.
    // After replaceBuffer rebuilds dedup to {c}, the pending 'b' should not be rejected as dup.
    act(() => result.current.enqueue([{ key: 'b', time: now - 1000, entity: 'e' }]));
    act(() => {
      result.current.replaceBuffer(
        [{ key: 'c', time: now - 2000, entity: 'e' }],
        { mode: 'refresh', preserveLiveTail: true },
      );
    });
    act(() => { flushTick?.(); });

    const keys = result.current.sortedRows.map(r => r.key);
    expect(keys).toContain('c');
    expect(keys).toContain('b');
  });
});
