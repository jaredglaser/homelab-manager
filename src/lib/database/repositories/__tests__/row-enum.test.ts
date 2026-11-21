import { describe, it, expect, spyOn, beforeEach } from 'bun:test';
import { parseNullableRowEnum, parseRowEnum, parseRowEnumOr, resetDegradedRowEnums } from '../row-enum';

const KNOWN = ['alpha', 'beta'] as const;

describe('parseRowEnum', () => {
  it('returns the value when the union knows it', () => {
    expect(parseRowEnum('table.column', 'beta', KNOWN)).toBe('beta');
  });

  it('logs and throws on a value the union does not know, naming the allowed values', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => parseRowEnum('table.column', 'gamma', KNOWN)).toThrow(
      'Unrecognized table.column value read from the database: "gamma" (expected one of alpha, beta)'
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('throws on a non-string value', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => parseRowEnum('table.column', 7, KNOWN)).toThrow('value read from the database: 7');
    errorSpy.mockRestore();
  });
});

describe('parseNullableRowEnum', () => {
  it('maps null and undefined to null', () => {
    expect(parseNullableRowEnum('table.column', null, KNOWN)).toBeNull();
    expect(parseNullableRowEnum('table.column', undefined, KNOWN)).toBeNull();
  });

  it('returns the value when the union knows it', () => {
    expect(parseNullableRowEnum('table.column', 'alpha', KNOWN)).toBe('alpha');
  });

  it('still throws on a value the union does not know', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => parseNullableRowEnum('table.column', 'gamma', KNOWN)).toThrow('"gamma"');
    errorSpy.mockRestore();
  });
});

describe('parseRowEnumOr', () => {
  beforeEach(() => resetDegradedRowEnums());

  it('returns the value when the union knows it, without logging', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(parseRowEnumOr('table.column', 'alpha', KNOWN, null)).toBe('alpha');
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('logs and returns the fallback instead of throwing', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(parseRowEnumOr('table.column', 'gamma', KNOWN, 'fallback')).toBe('fallback');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('"gamma"');
    errorSpy.mockRestore();
  });

  it('logs a value once per column, however many rows carry it', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    for (let row = 0; row < 50; row += 1) parseRowEnumOr('table.column', 'gamma', KNOWN, null);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('logs again for a different value and for the same value in another column', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    parseRowEnumOr('table.column', 'gamma', KNOWN, null);
    parseRowEnumOr('table.column', 'delta', KNOWN, null);
    parseRowEnumOr('other.column', 'gamma', KNOWN, null);
    parseRowEnumOr('table.column', 7, KNOWN, null);
    expect(errorSpy).toHaveBeenCalledTimes(4);
    errorSpy.mockRestore();
  });

  it('stops remembering past a bound so varied garbage cannot grow the set without limit', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    for (let n = 0; n < 500; n += 1) parseRowEnumOr('table.column', `value-${n}`, KNOWN, null);
    expect(errorSpy.mock.calls.length).toBeLessThan(500);
    expect(errorSpy.mock.calls.length).toBeGreaterThan(0);
    errorSpy.mockRestore();
  });
});
