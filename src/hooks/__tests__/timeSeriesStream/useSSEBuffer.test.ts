import { describe, it, expect } from 'bun:test';
import { useRef } from 'react';
import { renderHook, act } from '@testing-library/react';
import { useSSEBuffer } from '../../timeSeriesStream/useSSEBuffer';

interface Row {
  key: string;
  time: number;
}

function renderBuffer(windowSeconds = 60, updateIntervalMs = 30) {
  return renderHook(() => {
    const getKeyRef = useRef((r: Row) => r.key);
    const getTimeRef = useRef((r: Row) => r.time);
    return useSSEBuffer<Row>({ getKeyRef, getTimeRef, windowSeconds, updateIntervalMs });
  });
}

describe('useSSEBuffer', () => {
  it('starts empty with hasData=false', () => {
    const { result } = renderBuffer();
    expect(result.current.sortedRows).toEqual([]);
    expect(result.current.hasData).toBe(false);
  });

  it('replaceBuffer seeds rows sorted and marks hasData only when markHasData is set', () => {
    const { result } = renderBuffer();
    const now = Date.now();
    const rows: Row[] = [
      { key: 'b', time: now - 1000 },
      { key: 'a', time: now - 5000 },
    ];
    act(() => result.current.replaceBuffer(rows, { markHasData: true }));
    expect(result.current.sortedRows.map(r => r.key)).toEqual(['a', 'b']);
    expect(result.current.hasData).toBe(true);
    expect(result.current.lastDataTimeRef.current).not.toBeNull();
  });

  it('replaceBuffer without markHasData updates rows but leaves hasData false', () => {
    const { result } = renderBuffer();
    const now = Date.now();
    act(() => result.current.replaceBuffer([{ key: 'a', time: now }]));
    expect(result.current.sortedRows).toHaveLength(1);
    expect(result.current.hasData).toBe(false);
  });

  it('replaceBuffer is a no-op when rows is empty', () => {
    const { result } = renderBuffer();
    act(() => result.current.replaceBuffer([], { markHasData: true }));
    expect(result.current.sortedRows).toHaveLength(0);
    expect(result.current.hasData).toBe(false);
    expect(result.current.lastDataTimeRef.current).toBeNull();
  });

  it('replaceBuffer with preserveLiveTail stitches newer rows beyond the snapshot', async () => {
    const { result } = renderBuffer(60, 30);
    const now = Date.now();

    // Seed initial buffer
    act(() => result.current.replaceBuffer([{ key: 'a', time: now - 2000 }], { markHasData: true }));

    // Enqueue SSE rows newer than the snapshot
    act(() => result.current.enqueue([{ key: 'live', time: now + 500 }]));
    await act(async () => { await new Promise(r => setTimeout(r, 60)); });
    expect(result.current.sortedRows.map(r => r.key)).toContain('live');

    // Refresh with a new snapshot whose max time is earlier than 'live'
    act(() => result.current.replaceBuffer([{ key: 'a', time: now - 1000 }], { preserveLiveTail: true }));
    const keys = result.current.sortedRows.map(r => r.key);
    expect(keys).toEqual(['a', 'live']);
  });

  it('enqueue + periodic flush deduplicates against existing rows', async () => {
    const { result } = renderBuffer(60, 30);
    const now = Date.now();
    act(() => result.current.replaceBuffer([{ key: 'a', time: now - 1000 }], { markHasData: true }));

    act(() => result.current.enqueue([
      { key: 'a', time: now - 1000 }, // duplicate
      { key: 'b', time: now - 500 },
    ]));
    await act(async () => { await new Promise(r => setTimeout(r, 60)); });

    const keys = result.current.sortedRows.map(r => r.key);
    expect(keys).toEqual(['a', 'b']);
  });

  it('flush evicts rows older than the window', async () => {
    const { result } = renderBuffer(60, 30);
    const now = Date.now();
    act(() => result.current.replaceBuffer(
      [
        { key: 'old', time: now - 120_000 },
        { key: 'recent', time: now - 5000 },
      ],
      { markHasData: true },
    ));

    act(() => result.current.enqueue([{ key: 'new', time: now }]));
    await act(async () => { await new Promise(r => setTimeout(r, 60)); });

    const keys = result.current.sortedRows.map(r => r.key);
    expect(keys).not.toContain('old');
    expect(keys).toContain('recent');
    expect(keys).toContain('new');
  });

  it('flush with only duplicate pending rows still evicts (cutoff-only branch)', async () => {
    const { result } = renderBuffer(60, 30);
    const now = Date.now();
    act(() => result.current.replaceBuffer(
      [
        { key: 'old', time: now - 120_000 },
        { key: 'recent', time: now - 5000 },
      ],
      { markHasData: true },
    ));

    // Enqueue a row whose key already exists — newRows becomes empty after dedup,
    // but flush still evicts 'old'.
    act(() => result.current.enqueue([{ key: 'recent', time: now - 5000 }]));
    await act(async () => { await new Promise(r => setTimeout(r, 60)); });

    const keys = result.current.sortedRows.map(r => r.key);
    expect(keys).not.toContain('old');
    expect(keys).toContain('recent');
  });

  it('flush does nothing when the pending queue is empty', async () => {
    const { result } = renderBuffer(60, 30);
    const now = Date.now();
    act(() => result.current.replaceBuffer([{ key: 'a', time: now - 1000 }], { markHasData: true }));
    const before = result.current.sortedRows;
    await act(async () => { await new Promise(r => setTimeout(r, 60)); });
    // Same reference — flush skipped because no pending rows
    expect(result.current.sortedRows).toBe(before);
  });

  it('flush sets hasData=true when rows flush in', async () => {
    const { result } = renderBuffer(60, 30);
    const now = Date.now();
    expect(result.current.hasData).toBe(false);
    act(() => result.current.enqueue([{ key: 'a', time: now }]));
    await act(async () => { await new Promise(r => setTimeout(r, 60)); });
    expect(result.current.hasData).toBe(true);
  });
});
