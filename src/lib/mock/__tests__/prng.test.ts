import { describe, it, expect } from 'bun:test';
import { mulberry32, hashCode, seededRandom } from '../prng';

describe('mulberry32', () => {
  it('produces deterministic values for the same seed', () => {
    const rng1 = mulberry32(42);
    const rng2 = mulberry32(42);
    const values1 = Array.from({ length: 10 }, () => rng1());
    const values2 = Array.from({ length: 10 }, () => rng2());
    expect(values1).toEqual(values2);
  });

  it('produces different values for different seeds', () => {
    const rng1 = mulberry32(42);
    const rng2 = mulberry32(99);
    expect(rng1()).not.toEqual(rng2());
  });

  it('returns values in [0, 1)', () => {
    const rng = mulberry32(12345);
    for (let i = 0; i < 1000; i++) {
      const val = rng();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });
});

describe('hashCode', () => {
  it('returns the same value for the same string', () => {
    expect(hashCode('hello')).toBe(hashCode('hello'));
  });

  it('returns different values for different strings', () => {
    expect(hashCode('hello')).not.toBe(hashCode('world'));
  });

  it('returns a positive integer', () => {
    const result = hashCode('test');
    expect(result).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result)).toBe(true);
  });
});

describe('seededRandom', () => {
  it('is deterministic for the same parts', () => {
    expect(seededRandom('entity1', 'cpu', 1000)).toBe(
      seededRandom('entity1', 'cpu', 1000),
    );
  });

  it('varies with different parts', () => {
    expect(seededRandom('entity1', 'cpu', 1000)).not.toBe(
      seededRandom('entity2', 'cpu', 1000),
    );
  });

  it('returns values in [0, 1)', () => {
    const val = seededRandom('test', 'metric', 42);
    expect(val).toBeGreaterThanOrEqual(0);
    expect(val).toBeLessThan(1);
  });
});
