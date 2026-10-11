import { createRequire } from 'node:module';
import { mock } from 'bun:test';

type FullExportShape<T> = { [K in keyof T]-?: unknown };

// The base module is captured once per spec so within-file re-mocks spread the real exports, never a previous mock.
const capturedReal = new Map<string, unknown>();

export function mockModule<T extends object>(
  spec: string,
  factory: (real: T) => FullExportShape<T>,
): void {
  let real = capturedReal.get(spec) as T | undefined;
  if (real === undefined) {
    const req = createRequire(import.meta.url);
    // Packages with import-only exports maps fail bare require, so fall back to the resolved file.
    try {
      real = req(spec) as T;
    } catch {
      real = req(Bun.resolveSync(spec, import.meta.dir)) as T;
    }
    capturedReal.set(spec, real);
  }
  mock.module(spec, () => factory(real));
}
