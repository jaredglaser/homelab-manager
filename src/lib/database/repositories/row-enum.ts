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

export const MAX_REMEMBERED_DEGRADES = 200;
const degradedValues = new Set<string>();
let saturationLogged = false;

/** Clears the once-per-value memory of {@link parseRowEnumOr}, for tests. */
export function resetDegradedRowEnums(): void {
  degradedValues.clear();
  saturationLogged = false;
}

/** The value when the tuple knows it, otherwise null, without logging. For callers that log each miss themselves. */
export function readRowEnum<T extends string>(raw: unknown, values: readonly T[]): T | null {
  return typeof raw === 'string' && (values as readonly string[]).includes(raw) ? (raw as T) : null;
}

/**
 * Like {@link parseRowEnum}, but returns the fallback instead of throwing, for reads one bad row must not fail.
 * It logs once per column and value for the life of the process: a poll re-reads the same bad row every second,
 * and a repeat line per row would bury the log. The first sighting is the signal (for example a newer worker
 * writing a value this build does not know), so every later row with that value is skipped quietly. Past
 * MAX_REMEMBERED_DEGRADES distinct values it logs one line saying so and stops. Use it only for hot read paths,
 * a recovery path that drops rows should log each one.
 */
export function parseRowEnumOr<T extends string, F>(column: string, raw: unknown, values: readonly T[], fallback: F): T | F {
  if (typeof raw === 'string' && (values as readonly string[]).includes(raw)) return raw as T;
  const key = `${column}\u0000${JSON.stringify(raw)}`;
  if (degradedValues.has(key)) return fallback;
  if (degradedValues.size < MAX_REMEMBERED_DEGRADES) {
    degradedValues.add(key);
    console.error(`[repositories] ${describe(column, raw, values)} (read as ${JSON.stringify(fallback)}, repeats of this value are not logged again)`);
  } else if (!saturationLogged) {
    saturationLogged = true;
    console.error(`[repositories] ${MAX_REMEMBERED_DEGRADES} distinct unrecognized values were logged, further unknown values are not logged`);
  }
  return fallback;
}
