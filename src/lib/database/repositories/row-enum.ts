function describe(column: string, raw: unknown, values: readonly string[]): string {
  return `Unrecognized ${column} value read from the database: ${JSON.stringify(raw)} (expected one of ${values.join(', ')})`;
}

export function parseRowEnum<T extends string>(column: string, raw: unknown, values: readonly T[]): T {
  if (typeof raw === 'string' && (values as readonly string[]).includes(raw)) return raw as T;
  const message = describe(column, raw, values);
  console.error(`[repositories] ${message}`);
  throw new Error(message);
}

export function parseNullableRowEnum<T extends string>(column: string, raw: unknown, values: readonly T[]): T | null {
  if (raw === null || raw === undefined) return null;
  return parseRowEnum(column, raw, values);
}

/** Like {@link parseRowEnum}, but logs and returns the fallback instead of throwing, for reads one bad row must not fail. */
export function parseRowEnumOr<T extends string, F>(column: string, raw: unknown, values: readonly T[], fallback: F): T | F {
  if (typeof raw === 'string' && (values as readonly string[]).includes(raw)) return raw as T;
  console.error(`[repositories] ${describe(column, raw, values)}`);
  return fallback;
}
