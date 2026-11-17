import { describe, it, expect, spyOn } from 'bun:test';
import { parseNullableRowEnum, parseRowEnum } from '../row-enum';

const KNOWN = ['alpha', 'beta'] as const;
type Known = (typeof KNOWN)[number];

function isKnown(value: unknown): value is Known {
  return typeof value === 'string' && (KNOWN as readonly string[]).includes(value);
}

describe('parseRowEnum', () => {
  it('returns the value when the union knows it', () => {
    expect(parseRowEnum('table.column', 'beta', isKnown)).toBe('beta');
  });

  it('logs and throws on a value the union does not know', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => parseRowEnum('table.column', 'gamma', isKnown)).toThrow(
      'Unrecognized table.column value read from the database: "gamma"'
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('throws on a non-string value', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => parseRowEnum('table.column', 7, isKnown)).toThrow(
      'Unrecognized table.column value read from the database: 7'
    );
    errorSpy.mockRestore();
  });
});

describe('parseNullableRowEnum', () => {
  it('maps null and undefined to null', () => {
    expect(parseNullableRowEnum('table.column', null, isKnown)).toBeNull();
    expect(parseNullableRowEnum('table.column', undefined, isKnown)).toBeNull();
  });

  it('returns the value when the union knows it', () => {
    expect(parseNullableRowEnum('table.column', 'alpha', isKnown)).toBe('alpha');
  });

  it('logs and throws on an unknown non-null value', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => parseNullableRowEnum('table.column', 'gamma', isKnown)).toThrow(
      'Unrecognized table.column value read from the database: "gamma"'
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});
