/** Read a persisted enum column as its union, logging and throwing on a value the union does not know. */
export function parseRowEnum<T extends string>(
  column: string,
  raw: unknown,
  isKnown: (value: unknown) => value is T,
): T {
  if (isKnown(raw)) return raw;
  const message = `Unrecognized ${column} value read from the database: ${JSON.stringify(raw)}`;
  console.error(`[repositories] ${message}`);
  throw new Error(message);
}

/** Nullable variant of {@link parseRowEnum}: SQL NULL becomes null. */
export function parseNullableRowEnum<T extends string>(
  column: string,
  raw: unknown,
  isKnown: (value: unknown) => value is T,
): T | null {
  if (raw === null || raw === undefined) return null;
  return parseRowEnum(column, raw, isKnown);
}
