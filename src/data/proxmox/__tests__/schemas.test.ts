import { describe, it, expect } from 'bun:test';
import { getHistoricalProxmoxStatsSchema } from '../schemas';

describe('getHistoricalProxmoxStatsSchema', () => {
  it('defaults seconds to 120', () => {
    expect(getHistoricalProxmoxStatsSchema.parse({}).seconds).toBe(120);
  });

  it('accepts valid seconds', () => {
    expect(getHistoricalProxmoxStatsSchema.parse({ seconds: 300 }).seconds).toBe(300);
  });

  it('accepts seconds as undefined', () => {
    expect(getHistoricalProxmoxStatsSchema.parse({ seconds: undefined }).seconds).toBe(120);
  });

  it('rejects zero seconds', () => {
    expect(() => getHistoricalProxmoxStatsSchema.parse({ seconds: 0 })).toThrow();
  });

  it('rejects negative seconds', () => {
    expect(() => getHistoricalProxmoxStatsSchema.parse({ seconds: -1 })).toThrow();
  });

  it('rejects fractional seconds', () => {
    expect(() => getHistoricalProxmoxStatsSchema.parse({ seconds: 1.5 })).toThrow();
  });
});
