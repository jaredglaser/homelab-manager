import { describe, it, expect, spyOn } from 'bun:test';
import { parseNullableRowEnum, parseRowEnum, parseRowEnumOr } from '../row-enum';

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
});
