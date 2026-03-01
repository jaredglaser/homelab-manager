import { describe, it, expect, beforeEach } from 'bun:test';
import type { ZFSIOStatRaw } from '@/types/zfs';
import { ZFSRateCalculator, calculateZFSRates, clearZFSRatesCache } from '../zfs-rate-calculator';

function createMockZFSStats(overrides: Partial<ZFSIOStatRaw> = {}): ZFSIOStatRaw {
  return {
    name: 'tank',
    indent: 0,
    capacity: { alloc: 500_000_000_000, free: 500_000_000_000 }, // 500GB each
    operations: { read: 100, write: 50 },
    bandwidth: { read: 1024 * 1024 * 10, write: 1024 * 1024 * 5 },
    total: { readOps: 10000, writeOps: 5000, readBytes: 1024 * 1024 * 1024, writeBytes: 512 * 1024 * 1024 },
    ...overrides,
  };
}

describe('ZFSRateCalculator', () => {
  let calculator: ZFSRateCalculator;

  beforeEach(() => {
    calculator = new ZFSRateCalculator();
  });

  describe('calculate', () => {
    it('should return stats with rates and id/timestamp', () => {
      const stats = createMockZFSStats();
      const result = calculator.calculate('server1/tank', stats);

      expect(result.id).toBe('server1/tank');
      expect(result.timestamp).toBeGreaterThan(0);
      expect(result.name).toBe('tank');
      expect(result.indent).toBe(0);
    });

    it('should pass through operation and bandwidth rates from iostat', () => {
      const stats = createMockZFSStats({
        operations: { read: 200, write: 150 },
        bandwidth: { read: 1024 * 1024 * 20, write: 1024 * 1024 * 15 },
      });
      const result = calculator.calculate('server1/tank', stats);

      expect(result.rates.readOpsPerSec).toBe(200);
      expect(result.rates.writeOpsPerSec).toBe(150);
      expect(result.rates.readBytesPerSec).toBe(1024 * 1024 * 20);
      expect(result.rates.writeBytesPerSec).toBe(1024 * 1024 * 15);
    });

    it('should calculate utilization percentage correctly', () => {
      const stats = createMockZFSStats({
        capacity: { alloc: 750_000_000_000, free: 250_000_000_000 }, // 75% used
      });
      const result = calculator.calculate('server1/tank', stats);

      expect(result.rates.utilizationPercent).toBeCloseTo(75, 1);
    });

    it('should handle zero total capacity without division by zero', () => {
      const stats = createMockZFSStats({
        capacity: { alloc: 0, free: 0 },
      });
      const result = calculator.calculate('server1/tank', stats);

      expect(result.rates.utilizationPercent).toBe(0);
      expect(Number.isFinite(result.rates.utilizationPercent)).toBe(true);
    });

    it('should handle full capacity (100% used)', () => {
      const stats = createMockZFSStats({
        capacity: { alloc: 1_000_000_000_000, free: 0 },
      });
      const result = calculator.calculate('server1/tank', stats);

      expect(result.rates.utilizationPercent).toBeCloseTo(100, 1);
    });

    it('should handle empty pool (0% used)', () => {
      const stats = createMockZFSStats({
        capacity: { alloc: 0, free: 1_000_000_000_000 },
      });
      const result = calculator.calculate('server1/tank', stats);

      expect(result.rates.utilizationPercent).toBeCloseTo(0, 1);
    });

    it('should track multiple entities independently', () => {
      const stats1 = createMockZFSStats({
        name: 'tank',
        capacity: { alloc: 750_000_000_000, free: 250_000_000_000 },
      });
      const stats2 = createMockZFSStats({
        name: 'rpool',
        capacity: { alloc: 100_000_000_000, free: 900_000_000_000 },
      });

      const result1 = calculator.calculate('server1/tank', stats1);
      const result2 = calculator.calculate('server1/rpool', stats2);

      expect(result1.rates.utilizationPercent).toBeCloseTo(75, 1);
      expect(result2.rates.utilizationPercent).toBeCloseTo(10, 1);
    });

    it('should preserve original stats fields in result', () => {
      const stats = createMockZFSStats({
        name: 'mirror-0',
        indent: 2,
        total: { readOps: 999, writeOps: 888, readBytes: 777, writeBytes: 666 },
      });
      const result = calculator.calculate('server1/tank/mirror-0', stats);

      expect(result.name).toBe('mirror-0');
      expect(result.indent).toBe(2);
      expect(result.total.readOps).toBe(999);
      expect(result.total.writeOps).toBe(888);
      expect(result.capacity).toEqual(stats.capacity);
    });

    it('should update cache on each call', () => {
      const stats1 = createMockZFSStats({ operations: { read: 100, write: 50 } });
      const stats2 = createMockZFSStats({ operations: { read: 200, write: 150 } });

      calculator.calculate('server1/tank', stats1);
      const result = calculator.calculate('server1/tank', stats2);

      // Should reflect latest stats
      expect(result.rates.readOpsPerSec).toBe(200);
      expect(result.rates.writeOpsPerSec).toBe(150);
    });
  });

  describe('clear', () => {
    it('should clear all cached data', () => {
      calculator.calculate('server1/tank', createMockZFSStats());
      calculator.calculate('server1/rpool', createMockZFSStats());

      calculator.clear();

      // After clear, next calculate should still work (fresh start)
      const result = calculator.calculate('server1/tank', createMockZFSStats());
      expect(result.id).toBe('server1/tank');
      expect(result.rates.utilizationPercent).toBeCloseTo(50, 1);
    });
  });

  describe('remove', () => {
    it('should remove a specific entity from cache', () => {
      calculator.calculate('server1/tank', createMockZFSStats());
      calculator.calculate('server1/rpool', createMockZFSStats());

      calculator.remove('server1/tank');

      // Remaining entity should still work
      const result = calculator.calculate('server1/rpool', createMockZFSStats());
      expect(result.id).toBe('server1/rpool');
    });

    it('should not throw when removing non-existent entity', () => {
      expect(() => calculator.remove('nonexistent')).not.toThrow();
    });
  });
});

describe('convenience functions', () => {
  beforeEach(() => {
    clearZFSRatesCache();
  });

  it('calculateZFSRates should return rates using module-level calculator', () => {
    const stats = createMockZFSStats({
      capacity: { alloc: 600_000_000_000, free: 400_000_000_000 },
    });
    const result = calculateZFSRates('tank', stats);

    expect(result.id).toBe('tank');
    expect(result.rates.utilizationPercent).toBeCloseTo(60, 1);
  });

  it('clearZFSRatesCache should clear module-level calculator', () => {
    calculateZFSRates('tank', createMockZFSStats());
    clearZFSRatesCache();

    // Should work fine after clear
    const result = calculateZFSRates('tank', createMockZFSStats());
    expect(result.id).toBe('tank');
  });
});
