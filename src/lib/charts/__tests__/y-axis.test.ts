import { describe, it, expect } from 'bun:test';
import { findNiceInterval, calculateCleanYAxis } from '../y-axis';

describe('findNiceInterval', () => {
  it('should return a nice interval for small ranges', () => {
    // range=10, rough=2, magnitude=1, normalized=2 → nice=2
    expect(findNiceInterval(10)).toBe(2);
  });

  it('should return a nice interval for medium ranges', () => {
    // range=100, rough=20, magnitude=10, normalized=2 → nice=2 → 20
    expect(findNiceInterval(100)).toBe(20);
  });

  it('should return a nice interval for large ranges', () => {
    // range=1000, rough=200, magnitude=100, normalized=2 → nice=2 → 200
    expect(findNiceInterval(1000)).toBe(200);
  });

  it('should pick the smallest nice interval that fits', () => {
    // range=7, rough=1.4, magnitude=1, normalized=1.4 → nice=2
    expect(findNiceInterval(7)).toBe(2);
  });

  it('should handle fractional ranges', () => {
    // range=0.5, rough=0.1, magnitude=0.1, normalized=1 → nice=1 → 0.1
    expect(findNiceInterval(0.5)).toBe(0.1);
  });

  it('should fall back to magnitude * 10 when normalized is NaN (range=0)', () => {
    // roughInterval=0, magnitude=0, normalized=NaN → no nice matches → magnitude*10 = 0
    expect(findNiceInterval(0)).toBe(0);
  });

  it('should handle very large ranges', () => {
    // 100 PiB in bytes - upper bound for large-scale storage
    const hundredPiB = 100 * 1024 * 1024 * 1024 * 1024 * 1024;
    const result = findNiceInterval(hundredPiB);
    // rough = 100PiB/5 ≈ 2.25e16, magnitude = 1e16, normalized ≈ 2.25 → nice=5 → 5e16
    expect(result).toBe(5e16);
  });
});

describe('calculateCleanYAxis', () => {
  describe('default (linear mode)', () => {
    it('should return default config when maxValue is 0', () => {
      expect(calculateCleanYAxis(0)).toEqual({ max: 100, interval: 20 });
    });

    it('should return default config when maxValue is negative', () => {
      expect(calculateCleanYAxis(-5)).toEqual({ max: 100, interval: 20 });
    });

    it('should produce clean intervals for typical values', () => {
      const result = calculateCleanYAxis(45);
      expect(result.max).toBeGreaterThanOrEqual(45);
      expect(result.max % result.interval).toBe(0);
    });

    it('should handle very small values', () => {
      const result = calculateCleanYAxis(0.3);
      expect(result.max).toBeGreaterThanOrEqual(0.3);
      expect(result.interval).toBeGreaterThan(0);
    });

    it('should handle very large values', () => {
      const result = calculateCleanYAxis(999_999);
      expect(result.max).toBeGreaterThanOrEqual(999_999);
      expect(result.max % result.interval).toBe(0);
    });

    it('should produce approximately TARGET_TICKS ticks', () => {
      const result = calculateCleanYAxis(100);
      const ticks = result.max / result.interval;
      expect(ticks).toBeGreaterThanOrEqual(3);
      expect(ticks).toBeLessThanOrEqual(10);
    });
  });

  describe('percent mode', () => {
    it('should return default config when maxValue is 0', () => {
      expect(calculateCleanYAxis(0, 'percent')).toEqual({ max: 100, interval: 20 });
    });

    it('should cap at 100 for values under 100', () => {
      const result = calculateCleanYAxis(95, 'percent');
      expect(result.max).toBeLessThanOrEqual(100);
    });

    it('should add headroom below 100', () => {
      const result = calculateCleanYAxis(50, 'percent');
      expect(result.max).toBeGreaterThan(50);
      expect(result.max).toBeLessThanOrEqual(100);
    });

    it('should handle values at exactly 100', () => {
      const result = calculateCleanYAxis(100, 'percent');
      expect(result.max).toBe(100);
    });

    it('should handle small percentages', () => {
      const result = calculateCleanYAxis(5, 'percent');
      expect(result.max).toBeGreaterThanOrEqual(5);
      expect(result.max).toBeLessThanOrEqual(100);
    });
  });

  describe('bytes mode', () => {
    it('should return default config when maxValue is 0', () => {
      expect(calculateCleanYAxis(0, 'bytes')).toEqual({ max: 100, interval: 20 });
    });

    it('should use B-scale for small values', () => {
      const result = calculateCleanYAxis(500, 'bytes');
      expect(result.max).toBeGreaterThanOrEqual(500);
      expect(result.max).toBeLessThan(1024);
    });

    it('should use KiB-scale for KiB-range values', () => {
      const result = calculateCleanYAxis(50 * 1024, 'bytes');
      expect(result.max).toBeGreaterThanOrEqual(50 * 1024);
      // Should be a clean multiple of KiB
      expect(result.max % 1024).toBe(0);
    });

    it('should use MiB-scale for MiB-range values', () => {
      const result = calculateCleanYAxis(150 * 1024 * 1024, 'bytes');
      expect(result.max).toBeGreaterThanOrEqual(150 * 1024 * 1024);
      // Should be a clean multiple of MiB
      expect(result.max % (1024 * 1024)).toBe(0);
    });

    it('should use GiB-scale for GiB-range values', () => {
      const result = calculateCleanYAxis(2 * 1024 * 1024 * 1024, 'bytes');
      expect(result.max).toBeGreaterThanOrEqual(2 * 1024 * 1024 * 1024);
    });

    it('should produce clean intervals aligned to byte units', () => {
      const result = calculateCleanYAxis(10 * 1024 * 1024, 'bytes');
      expect(result.max % result.interval).toBe(0);
    });
  });

  describe('bits mode', () => {
    it('should return default config when maxValue is 0', () => {
      expect(calculateCleanYAxis(0, 'bits')).toEqual({ max: 100, interval: 20 });
    });

    it('should produce axis values that are clean SI bit multiples', () => {
      // 1_000_000 bps = 1 Mbps exactly
      const result = calculateCleanYAxis(1_000_000, 'bits');
      expect(result.interval % 1000).toBe(0);
      expect(result.max % 1000).toBe(0);
    });

    it('should use bps-scale for low throughput', () => {
      // 400 bps stays in bps range
      const result = calculateCleanYAxis(400, 'bits');
      expect(result.max).toBeGreaterThanOrEqual(400);
      expect(result.interval).toBeLessThan(1000);
    });

    it('should use Kbps-scale for Kbps-range throughput', () => {
      // 200_000 bps = 200 Kbps
      const result = calculateCleanYAxis(200_000, 'bits');
      expect(result.max).toBeGreaterThanOrEqual(200_000);
      expect(result.interval % 1000).toBe(0);
      expect(result.interval).toBeGreaterThanOrEqual(1000);
      expect(result.interval).toBeLessThan(1_000_000);
    });

    it('should use Mbps-scale for Mbps-range throughput', () => {
      // 100_000_000 bps = 100 Mbps
      const result = calculateCleanYAxis(100_000_000, 'bits');
      expect(result.max).toBeGreaterThanOrEqual(100_000_000);
      expect(result.interval % 1_000_000).toBe(0);
    });

    it('should use Gbps-scale for Gbps-range throughput', () => {
      // 10_000_000_000 bps = 10 Gbps
      const result = calculateCleanYAxis(10_000_000_000, 'bits');
      expect(result.max).toBeGreaterThanOrEqual(10_000_000_000);
      expect(result.interval % 1_000_000_000).toBe(0);
    });

    it('max should be divisible by interval', () => {
      const result = calculateCleanYAxis(30_000_000, 'bits');
      expect(result.max % result.interval).toBe(0);
    });
  });
});
