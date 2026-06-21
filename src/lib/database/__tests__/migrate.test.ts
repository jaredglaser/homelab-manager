import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runMigrations, MIGRATIONS_ADVISORY_LOCK_KEY } from '@/lib/database/migrate';
import type { DatabaseClient } from '@/lib/clients/database-client';

const migrationFiles = readdirSync(join(import.meta.dir, '..', '..', '..', '..', 'migrations'))
  .filter((file) => file.endsWith('.sql'))
  .sort();

interface QueryCall {
  text: string;
  values?: unknown[];
}

interface FakeClient {
  calls: QueryCall[];
  releaseCount: number;
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

function createFakeClient(
  handler: (text: string, values?: unknown[]) => { rows: unknown[] } | undefined,
): FakeClient {
  const client: FakeClient = {
    calls: [],
    releaseCount: 0,
    async query(text: string, values?: unknown[]) {
      client.calls.push({ text, values });
      return handler(text, values) ?? { rows: [] };
    },
    release() {
      client.releaseCount += 1;
    },
  };
  return client;
}

function createFakeDb(client: FakeClient): DatabaseClient {
  return {
    getPool: () => ({ connect: async () => client }),
  } as unknown as DatabaseClient;
}

describe('runMigrations', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('takes the advisory lock first and releases it last on the same connection', async () => {
    const client = createFakeClient((text) => {
      if (text.startsWith('SELECT 1 FROM migrations')) return { rows: [{ applied: 1 }] };
      return undefined;
    });

    await runMigrations(createFakeDb(client));

    expect(client.calls[0]).toEqual({
      text: 'SELECT pg_advisory_lock($1)',
      values: [MIGRATIONS_ADVISORY_LOCK_KEY],
    });
    expect(client.calls[client.calls.length - 1]).toEqual({
      text: 'SELECT pg_advisory_unlock($1)',
      values: [MIGRATIONS_ADVISORY_LOCK_KEY],
    });
    expect(client.releaseCount).toBe(1);
  });

  test('skips already-applied migrations without opening transactions', async () => {
    const client = createFakeClient((text) => {
      if (text.startsWith('SELECT 1 FROM migrations')) return { rows: [{ applied: 1 }] };
      return undefined;
    });

    await runMigrations(createFakeDb(client));

    const texts = client.calls.map((c) => c.text);
    expect(texts).not.toContain('BEGIN');
    expect(texts.filter((t) => t.startsWith('SELECT 1 FROM migrations'))).toHaveLength(
      migrationFiles.length,
    );
  });

  test('applies a pending migration inside a transaction and records it', async () => {
    let pendingChecks = 0;
    const client = createFakeClient((text) => {
      if (text.startsWith('SELECT 1 FROM migrations')) {
        pendingChecks += 1;
        // First file is pending, the rest already applied.
        return pendingChecks === 1 ? { rows: [] } : { rows: [{ applied: 1 }] };
      }
      return undefined;
    });

    await runMigrations(createFakeDb(client));

    const texts = client.calls.map((c) => c.text);
    const beginIdx = texts.indexOf('BEGIN');
    const commitIdx = texts.indexOf('COMMIT');
    const insertIdx = texts.findIndex((t) => t.startsWith('INSERT INTO migrations'));
    expect(beginIdx).toBeGreaterThan(0);
    expect(insertIdx).toBeGreaterThan(beginIdx);
    expect(commitIdx).toBeGreaterThan(insertIdx);
    expect(client.calls[insertIdx].values).toEqual([migrationFiles[0]]);
  });

  test('rolls back on failure and still unlocks and releases the connection', async () => {
    const client = createFakeClient((text) => {
      if (text.startsWith('SELECT 1 FROM migrations')) return { rows: [] };
      if (text.startsWith('INSERT INTO migrations')) throw new Error('insert failed');
      return undefined;
    });

    await expect(runMigrations(createFakeDb(client))).rejects.toThrow('insert failed');

    const texts = client.calls.map((c) => c.text);
    expect(texts).toContain('ROLLBACK');
    expect(client.calls[client.calls.length - 1]).toEqual({
      text: 'SELECT pg_advisory_unlock($1)',
      values: [MIGRATIONS_ADVISORY_LOCK_KEY],
    });
    expect(client.releaseCount).toBe(1);
  });
});
