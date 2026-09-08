import { describe, it, expect } from 'bun:test';
import {
  getHistoricalDockerStatsSchema,
  getContainerHistorySchema,
  updateContainerIconSchema,
} from '../schemas';

describe('getHistoricalDockerStatsSchema', () => {
  it('defaults seconds to 60', () => {
    expect(getHistoricalDockerStatsSchema.parse({}).seconds).toBe(60);
  });

  it('accepts valid seconds', () => {
    expect(getHistoricalDockerStatsSchema.parse({ seconds: 300 }).seconds).toBe(300);
  });

  it('rejects out-of-range seconds', () => {
    expect(() => getHistoricalDockerStatsSchema.parse({ seconds: 0 })).toThrow();
    expect(() => getHistoricalDockerStatsSchema.parse({ seconds: 3601 })).toThrow();
  });
});

describe('getContainerHistorySchema', () => {
  it('accepts valid input', () => {
    const result = getContainerHistorySchema.parse({ containerId: 'abc123', fromMs: 1000, toMs: 2000 });
    expect(result.containerId).toBe('abc123');
    expect(result.host).toBeUndefined();
  });

  it('accepts optional host and targetPoints', () => {
    const result = getContainerHistorySchema.parse({ containerId: 'x', host: 'h1', fromMs: 0, toMs: 1, targetPoints: 100 });
    expect(result.host).toBe('h1');
    expect(result.targetPoints).toBe(100);
  });

  it('rejects empty containerId', () => {
    expect(() => getContainerHistorySchema.parse({ containerId: '', fromMs: 0, toMs: 0 })).toThrow();
  });

  it('rejects targetPoints out of range', () => {
    expect(() => getContainerHistorySchema.parse({ containerId: 'x', fromMs: 0, toMs: 0, targetPoints: 0 })).toThrow();
    expect(() => getContainerHistorySchema.parse({ containerId: 'x', fromMs: 0, toMs: 0, targetPoints: 5001 })).toThrow();
  });

  it('rejects negative timestamps', () => {
    expect(() => getContainerHistorySchema.parse({ containerId: 'x', fromMs: -1, toMs: 1000 })).toThrow();
    expect(() => getContainerHistorySchema.parse({ containerId: 'x', fromMs: 0, toMs: -1 })).toThrow();
  });

  it('rejects fractional timestamps', () => {
    expect(() => getContainerHistorySchema.parse({ containerId: 'x', fromMs: 1.5, toMs: 2000 })).toThrow();
  });

  it('rejects fromMs greater than toMs', () => {
    expect(() => getContainerHistorySchema.parse({ containerId: 'x', fromMs: 2000, toMs: 1000 })).toThrow();
  });
});

describe('updateContainerIconSchema', () => {
  it('accepts valid input', () => {
    const result = updateContainerIconSchema.parse({ serviceKeyEntity: 'host/svc', iconSlug: 'nginx' });
    expect(result.serviceKeyEntity).toBe('host/svc');
  });

  it('rejects empty fields', () => {
    expect(() => updateContainerIconSchema.parse({ serviceKeyEntity: '', iconSlug: 'x' })).toThrow();
    expect(() => updateContainerIconSchema.parse({ serviceKeyEntity: 'x', iconSlug: '' })).toThrow();
  });
});
