interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Collects every check before failing so one broken migration reports the full
 * picture instead of only the first assertion to trip.
 */
export class Checks {
  private readonly results: CheckResult[] = [];

  constructor(private readonly scenario: string) {}

  record(name: string, ok: boolean, detail = ''): void {
    this.results.push({ name, ok, detail });
  }

  equal(name: string, actual: unknown, expected: unknown): void {
    const ok = Object.is(actual, expected);
    this.record(name, ok, ok ? '' : `expected ${format(expected)}, got ${format(actual)}`);
  }

  closeTo(name: string, actual: number, expected: number, epsilon: number): void {
    const delta = Math.abs(actual - expected);
    const ok = Number.isFinite(delta) && delta <= epsilon;
    this.record(
      name,
      ok,
      ok ? '' : `expected ${expected} +/- ${epsilon}, got ${actual} (delta ${delta})`
    );
  }

  differsBy(name: string, actual: number, other: number, minimumDelta: number): void {
    const delta = Math.abs(actual - other);
    const ok = Number.isFinite(delta) && delta >= minimumDelta;
    this.record(
      name,
      ok,
      ok ? '' : `expected the two values to differ by at least ${minimumDelta}, got ${delta}`
    );
  }

  sameSet(name: string, actual: readonly string[], expected: readonly string[]): void {
    const actualSet = new Set(actual);
    const missing = expected.filter(value => !actualSet.has(value));
    const expectedSet = new Set(expected);
    const unexpected = actual.filter(value => !expectedSet.has(value));
    const ok = missing.length === 0 && unexpected.length === 0;
    this.record(
      name,
      ok,
      ok ? '' : `missing [${missing.join(', ')}], unexpected [${unexpected.join(', ')}]`
    );
  }

  containsAll(name: string, actual: readonly string[], expected: readonly string[]): void {
    const actualSet = new Set(actual);
    const missing = expected.filter(value => !actualSet.has(value));
    this.record(name, missing.length === 0, missing.length ? `missing [${missing.join(', ')}]` : '');
  }

  report(): void {
    const failures = this.results.filter(result => !result.ok);
    for (const result of this.results) {
      const status = result.ok ? 'PASS' : 'FAIL';
      const detail = result.detail ? ` (${result.detail})` : '';
      console.info(`[${this.scenario}] ${status} ${result.name}${detail}`);
    }
    console.info(
      `[${this.scenario}] ${this.results.length - failures.length}/${this.results.length} checks passed`
    );
    if (failures.length > 0) {
      throw new Error(
        `[${this.scenario}] ${failures.length} check(s) failed: ${failures.map(f => f.name).join(', ')}`
      );
    }
  }
}

function format(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
}
