import { describe, test, expect } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const migrationsDir = join(import.meta.dir, '..', '..', '..', '..', 'migrations');

const PREFIX_PATTERN = /^(\d{3})_/;

function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

describe('migration filenames', () => {
  test('the migrations directory is readable and not empty', () => {
    expect(migrationFiles().length).toBeGreaterThan(0);
  });

  test('every file is three digits then an underscore, so lexicographic sort is numeric order', () => {
    const malformed = migrationFiles().filter((file) => !PREFIX_PATTERN.test(file));
    expect(malformed).toEqual([]);
  });

  test('no two files share a numeric prefix', () => {
    const byPrefix = new Map<string, string[]>();
    for (const file of migrationFiles()) {
      const prefix = PREFIX_PATTERN.exec(file)?.[1] ?? file;
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), file]);
    }

    const collisions = [...byPrefix.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([prefix, files]) => `${prefix} -> ${files.join(', ')}`)
      .sort();

    expect(collisions).toEqual([]);
  });
});
