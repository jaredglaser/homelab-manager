import { describe, it, expect } from 'bun:test';
import { LogBatcher, renderLogBatch, sampleForProfiling, truncateLine } from '@/lib/ai/log-batcher';
import type { LogLine } from '@/types/ai';

function line(text: string, at: number | null = 1_700_000_000_000, stream: 'stdout' | 'stderr' = 'stdout'): LogLine {
  return { at, stream, text };
}

describe('truncateLine', () => {
  it('leaves a short line alone', () => {
    expect(truncateLine('hello', 10)).toBe('hello');
  });

  it('marks how much was dropped', () => {
    const result = truncateLine('a'.repeat(20), 5);
    expect(result.startsWith('aaaaa')).toBe(true);
    expect(result).toContain('+15 chars truncated');
  });
});

describe('LogBatcher', () => {
  it('flushes at the line ceiling', () => {
    const batcher = new LogBatcher({ maxLines: 3, maxChars: 10_000 });
    expect(batcher.push(line('a'))).toBeNull();
    expect(batcher.push(line('b'))).toBeNull();
    const batch = batcher.push(line('c'));
    expect(batch?.map((l) => l.text)).toEqual(['a', 'b', 'c']);
    expect(batcher.pendingLines).toBe(0);
  });

  it('flushes at the character ceiling before the line ceiling', () => {
    const batcher = new LogBatcher({ maxLines: 100, maxChars: 10 });
    expect(batcher.push(line('12345'))).toBeNull();
    expect(batcher.push(line('67890'))?.length).toBe(2);
  });

  it('truncates an oversized line before buffering it', () => {
    const batcher = new LogBatcher({ maxLines: 1, maxChars: 10_000, maxLineChars: 4 });
    const batch = batcher.push(line('abcdefghij'));
    expect(batch?.[0].text.startsWith('abcd')).toBe(true);
    expect(batch?.[0].text).toContain('truncated');
  });

  it('drain returns null when empty and the buffer otherwise', () => {
    const batcher = new LogBatcher({ maxLines: 10, maxChars: 10_000 });
    expect(batcher.drain()).toBeNull();
    batcher.push(line('x'));
    expect(batcher.pendingLines).toBe(1);
    expect(batcher.drain()?.length).toBe(1);
    expect(batcher.drain()).toBeNull();
  });
});

describe('renderLogBatch', () => {
  it('renders timestamp, stream marker and text', () => {
    const rendered = renderLogBatch([
      line('up', Date.UTC(2026, 0, 2, 3, 4, 5)),
      line('boom', null, 'stderr'),
    ]);
    expect(rendered).toBe('2026-01-02T03:04:05.000Z O up\n-- E boom');
  });
});

describe('sampleForProfiling', () => {
  it('returns the input when it already fits', () => {
    const lines = [line('a'), line('b')];
    expect(sampleForProfiling(lines, 1000)).toBe(lines);
  });

  it('returns the input when there is nothing to sample', () => {
    expect(sampleForProfiling([], 1)).toEqual([]);
  });

  it('keeps both ends and strides the middle', () => {
    const lines = Array.from({ length: 400 }, (_, i) => line(`line-${i}`));
    const sampled = sampleForProfiling(lines, 400);

    expect(sampled.length).toBeLessThan(lines.length);
    expect(sampled[0].text).toBe('line-0');
    expect(sampled.at(-1)?.text).toBe('line-399');
  });

  it('falls back to head and tail when the budget leaves no room for a middle', () => {
    const lines = Array.from({ length: 50 }, (_, i) => line('x'.repeat(20) + i));
    const sampled = sampleForProfiling(lines, 70);
    expect(sampled.length).toBeGreaterThanOrEqual(2);
    expect(sampled[0]).toBe(lines[0]);
    expect(sampled.at(-1)).toBe(lines.at(-1));
  });
});
