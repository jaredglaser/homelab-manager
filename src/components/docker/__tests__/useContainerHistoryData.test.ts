import { describe, it, expect, mock } from 'bun:test';

mock.module('@/data/docker/functions', () => ({
  getContainerHistory: async () => [],
  getContainerInfo: async () => null,
}));

const { parseMetrics, DEFAULT_RANGE_MS } = await import('@/components/docker/useContainerHistoryData');

describe('parseMetrics', () => {
  it('parses comma-separated metric strings', () => {
    const result = parseMetrics('cpu,memory');
    expect(result.has('cpu')).toBe(true);
    expect(result.has('memory')).toBe(true);
  });

  it('parses all six valid metrics', () => {
    const result = parseMetrics('cpu,memory,blockRead,blockWrite,networkRx,networkTx');
    expect(result.size).toBe(6);
  });

  it('falls back to cpu,memory when empty string provided', () => {
    const result = parseMetrics('');
    expect(result.has('cpu')).toBe(true);
    expect(result.has('memory')).toBe(true);
    expect(result.size).toBe(2);
  });

  it('filters out invalid metric names', () => {
    const result = parseMetrics('cpu,invalid,memory');
    expect(result.has('cpu')).toBe(true);
    expect(result.has('memory')).toBe(true);
    expect(result.has('invalid' as never)).toBe(false);
  });

  it('falls back to defaults when all metrics are invalid', () => {
    const result = parseMetrics('invalid,also-invalid');
    expect(result.has('cpu')).toBe(true);
    expect(result.has('memory')).toBe(true);
  });

  it('parses single metric', () => {
    const result = parseMetrics('cpu');
    expect(result.has('cpu')).toBe(true);
    expect(result.size).toBe(1);
  });
});

describe('DEFAULT_RANGE_MS', () => {
  it('is 1 hour in milliseconds', () => {
    expect(DEFAULT_RANGE_MS).toBe(3_600_000);
  });
});
