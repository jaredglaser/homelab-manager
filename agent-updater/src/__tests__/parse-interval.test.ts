import { describe, expect, test } from 'bun:test';
import { parseInterval } from '../parse-interval';

describe('parseInterval', () => {
  test('parses hours', () => {
    expect(parseInterval('6h')).toBe(6 * 60 * 60 * 1000);
    expect(parseInterval('1h')).toBe(3_600_000);
  });

  test('parses minutes', () => {
    expect(parseInterval('30m')).toBe(30 * 60 * 1000);
    expect(parseInterval('1m')).toBe(60_000);
  });

  test('parses seconds', () => {
    expect(parseInterval('10s')).toBe(10_000);
    expect(parseInterval('1s')).toBe(1_000);
  });

  test('throws on invalid format', () => {
    expect(() => parseInterval('abc')).toThrow('Invalid interval format');
    expect(() => parseInterval('6x')).toThrow('Invalid interval format');
    expect(() => parseInterval('')).toThrow('Invalid interval format');
    expect(() => parseInterval('h')).toThrow('Invalid interval format');
  });

  test('throws on zero values', () => {
    expect(() => parseInterval('0h')).toThrow('Value must be greater than zero');
    expect(() => parseInterval('0m')).toThrow('Value must be greater than zero');
    expect(() => parseInterval('0s')).toThrow('Value must be greater than zero');
  });
});
