import { describe, it, expect } from 'bun:test';
import { clamp, lerp, smoothstep, sine, noise, smoothNoise, generateMetric, spike } from '../patterns';
import type { MetricProfile } from '../patterns';

describe('clamp', () => {
  it('returns value when within range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('returns min when below', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
  });

  it('returns max when above', () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });
});

describe('lerp', () => {
  it('returns a at t=0', () => {
    expect(lerp(10, 20, 0)).toBe(10);
  });

  it('returns b at t=1', () => {
    expect(lerp(10, 20, 1)).toBe(20);
  });

  it('returns midpoint at t=0.5', () => {
    expect(lerp(10, 20, 0.5)).toBe(15);
  });
});

describe('smoothstep', () => {
  it('returns 0 at t=0', () => {
    expect(smoothstep(0)).toBe(0);
  });

  it('returns 1 at t=1', () => {
    expect(smoothstep(1)).toBe(1);
  });

  it('returns 0.5 at t=0.5', () => {
    expect(smoothstep(0.5)).toBe(0.5);
  });

  it('clamps below 0', () => {
    expect(smoothstep(-1)).toBe(0);
  });

  it('clamps above 1', () => {
    expect(smoothstep(2)).toBe(1);
  });
});

describe('sine', () => {
  it('is deterministic', () => {
    const a = sine(1000, 'entity1', 50, 10, 60000);
    const b = sine(1000, 'entity1', 50, 10, 60000);
    expect(a).toBe(b);
  });

  it('produces different values for different entities', () => {
    const a = sine(1000, 'entity1', 50, 10, 60000);
    const b = sine(1000, 'entity2', 50, 10, 60000);
    expect(a).not.toBe(b);
  });

  it('oscillates around the base', () => {
    const values: number[] = [];
    for (let t = 0; t < 60000; t += 1000) {
      values.push(sine(t, 'test', 50, 10, 60000));
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    expect(min).toBeLessThan(50);
    expect(max).toBeGreaterThan(50);
  });
});

describe('noise', () => {
  it('is deterministic', () => {
    expect(noise(1000, 'e', 'm', 5000)).toBe(noise(1000, 'e', 'm', 5000));
  });

  it('returns values in [0, 1)', () => {
    for (let t = 0; t < 100000; t += 1000) {
      const val = noise(t, 'entity', 'metric', 5000);
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });
});

describe('smoothNoise', () => {
  it('is deterministic', () => {
    expect(smoothNoise(1234, 'e', 'm')).toBe(smoothNoise(1234, 'e', 'm'));
  });

  it('returns values in [0, 1)', () => {
    for (let t = 0; t < 100000; t += 500) {
      const val = smoothNoise(t, 'entity', 'metric', 5000);
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });
});

describe('generateMetric', () => {
  const profile: MetricProfile = {
    base: 50,
    amplitude: 20,
    periodMs: 60000,
    noiseLevel: 5,
    min: 0,
    max: 100,
  };

  it('is deterministic', () => {
    const a = generateMetric(5000, 'entity', 'metric', profile);
    const b = generateMetric(5000, 'entity', 'metric', profile);
    expect(a).toBe(b);
  });

  it('respects min/max bounds', () => {
    for (let t = 0; t < 300000; t += 500) {
      const val = generateMetric(t, 'test', 'cpu', profile);
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(100);
    }
  });

  it('varies over time', () => {
    const a = generateMetric(0, 'entity', 'metric', profile);
    const b = generateMetric(30000, 'entity', 'metric', profile);
    expect(a).not.toBe(b);
  });
});

describe('spike', () => {
  it('is deterministic', () => {
    expect(spike(1000, 'e', 'm', 60000, 5000, 50)).toBe(
      spike(1000, 'e', 'm', 60000, 5000, 50),
    );
  });

  it('returns 0 or positive', () => {
    for (let t = 0; t < 300000; t += 500) {
      const val = spike(t, 'entity', 'metric', 60000, 5000, 50);
      expect(val).toBeGreaterThanOrEqual(0);
    }
  });
});
