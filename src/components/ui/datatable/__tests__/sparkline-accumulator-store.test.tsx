import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  getSparklinePoints,
  ingestSparklineData,
  resetSparklineStore,
  subscribeSparkline,
} from '@/components/ui/datatable/sparkline-accumulator-store';

const NOW = 1_700_000_000_000;

function makePoints(offsets: number[], value = 50) {
  return offsets.map((offset) => ({ timestamp: NOW + offset, value }));
}

beforeEach(() => {
  resetSparklineStore();
});

describe('ingestSparklineData', () => {
  it('returns an empty array for an unknown key', () => {
    expect(getSparklinePoints('missing')).toEqual([]);
  });

  it('ignores empty data without creating a series', () => {
    ingestSparklineData('a', [], NOW);
    expect(getSparklinePoints('a')).toEqual([]);
  });

  it('waits (no points) while the latest point is stale', () => {
    ingestSparklineData('a', makePoints([-5000]), NOW);
    expect(getSparklinePoints('a')).toEqual([]);
  });

  it('seeds the window once a fresh point arrives', () => {
    ingestSparklineData('a', makePoints([-1000, 0]), NOW);
    expect(getSparklinePoints('a')).toHaveLength(2);
  });

  it('transitions from waiting to seeded when fresh data follows stale data', () => {
    ingestSparklineData('a', makePoints([-5000]), NOW);
    expect(getSparklinePoints('a')).toEqual([]);

    ingestSparklineData('a', makePoints([-500, 0]), NOW);
    expect(getSparklinePoints('a')).toHaveLength(2);
  });

  it('appends only points newer than the last seen timestamp', () => {
    ingestSparklineData('a', makePoints([-1000, 0]), NOW);
    ingestSparklineData('a', makePoints([-1000, 0, 1000]), NOW);
    expect(getSparklinePoints('a')).toHaveLength(3);
  });

  it('is idempotent: replaying the same window keeps the same array reference', () => {
    const data = makePoints([-1000, 0]);
    ingestSparklineData('a', data, NOW);
    const first = getSparklinePoints('a');
    ingestSparklineData('a', data, NOW);
    expect(getSparklinePoints('a')).toBe(first);
  });

  it('drops points older than the 35s window when accumulating', () => {
    ingestSparklineData('a', makePoints([0]), NOW);
    const old = { timestamp: NOW - 36000, value: 1 };
    ingestSparklineData('a', [old, { timestamp: NOW, value: 2 }, { timestamp: NOW + 1000, value: 3 }], NOW);

    const points = getSparklinePoints('a');
    expect(points.every((p) => p.timestamp >= NOW + 1000 - 35000)).toBe(true);
    expect(points.some((p) => p.timestamp === old.timestamp)).toBe(false);
  });
});

describe('subscribeSparkline eviction', () => {
  let setTimeoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  it('evicts the series once the last subscriber leaves', () => {
    ingestSparklineData('a', makePoints([0]), NOW);
    const unsubscribe = subscribeSparkline('a', () => {});
    expect(getSparklinePoints('a')).toHaveLength(1);

    unsubscribe();
    expect(getSparklinePoints('a')).toEqual([]);
  });

  it('keeps the series while another subscriber remains', () => {
    ingestSparklineData('a', makePoints([0]), NOW);
    const first = subscribeSparkline('a', () => {});
    const second = subscribeSparkline('a', () => {});

    first();
    expect(getSparklinePoints('a')).toHaveLength(1);

    second();
    expect(getSparklinePoints('a')).toEqual([]);
  });
});

describe('subscribeSparkline resume', () => {
  it('cancels a pending eviction when a subscriber returns before the grace window', () => {
    // setTimeout returns an id but never fires, modelling a still-pending eviction.
    const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
    const setSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((_fn: () => void) =>
      1 as unknown as ReturnType<typeof setTimeout>) as typeof setTimeout);

    try {
      ingestSparklineData('a', makePoints([0]), NOW);
      const unsubscribe = subscribeSparkline('a', () => {});
      unsubscribe();

      // Resubscribing before the grace window must cancel the scheduled eviction.
      subscribeSparkline('a', () => {});

      expect(clearSpy).toHaveBeenCalled();
      expect(getSparklinePoints('a')).toHaveLength(1);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});
