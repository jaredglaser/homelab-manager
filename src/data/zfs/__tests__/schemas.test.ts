import { describe, it, expect } from 'bun:test';
import { getHistoricalZFSStatsSchema } from '../schemas';

describe('getHistoricalZFSStatsSchema', () => {
  it('defaults seconds to 60', () => {
    expect(getHistoricalZFSStatsSchema.parse({}).seconds).toBe(60);
  });

  it('accepts valid seconds', () => {
    expect(getHistoricalZFSStatsSchema.parse({ seconds: 300 }).seconds).toBe(300);
  });

  it('accepts seconds as undefined', () => {
    expect(getHistoricalZFSStatsSchema.parse({ seconds: undefined }).seconds).toBe(60);
  });

  it('rejects zero seconds', () => {
    expect(() => getHistoricalZFSStatsSchema.parse({ seconds: 0 })).toThrow();
  });

  it('rejects negative seconds', () => {
    expect(() => getHistoricalZFSStatsSchema.parse({ seconds: -1 })).toThrow();
  });

  it('rejects fractional seconds', () => {
    expect(() => getHistoricalZFSStatsSchema.parse({ seconds: 1.5 })).toThrow();
  });
});
