import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  runMigrations,
  splitSqlStatements,
  MIGRATIONS_ADVISORY_LOCK_KEY,
} from '@/lib/database/migrate';
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

  test('applies a migrate:no-transaction migration one statement at a time', async () => {
    const noTxMigration = '030_docker_stats_retention_cascade.sql';
    const client = createFakeClient((text, values) => {
      if (text.startsWith('SELECT 1 FROM migrations')) {
        return values?.[0] === noTxMigration ? { rows: [] } : { rows: [{ applied: 1 }] };
      }
      return undefined;
    });

    await runMigrations(createFakeDb(client));

    const texts = client.calls.map((c) => c.text);
    expect(texts).not.toContain('BEGIN');
    expect(texts).not.toContain('COMMIT');

    const refreshCalls = texts.filter((t) => t.startsWith('CALL refresh_continuous_aggregate'));
    expect(refreshCalls.length).toBeGreaterThan(1);
    for (const call of refreshCalls) {
      expect(call).not.toContain(';');
    }

    // The DO block's inner semicolons must not split it into fragments.
    const doBlock = texts.find((t) => t.startsWith('DO $$'));
    expect(doBlock).toContain('set_chunk_time_interval');
    expect(doBlock?.endsWith('$$')).toBe(true);

    const insertIdx = texts.findIndex((t) => t.startsWith('INSERT INTO migrations'));
    expect(client.calls[insertIdx].values).toEqual([noTxMigration]);
  });

  test('drops raw retention only after every backfill statement has run', async () => {
    const noTxMigration = '030_docker_stats_retention_cascade.sql';
    const client = createFakeClient((text, values) => {
      if (text.startsWith('SELECT 1 FROM migrations')) {
        return values?.[0] === noTxMigration ? { rows: [] } : { rows: [{ applied: 1 }] };
      }
      return undefined;
    });

    await runMigrations(createFakeDb(client));

    const texts = client.calls.map((c) => c.text);
    const lastRefreshIdx = texts.reduce(
      (found, text, index) => (text.startsWith('CALL refresh_continuous_aggregate') ? index : found),
      -1,
    );
    const rawRetentionIdx = texts.findIndex(
      (t) => t.includes("add_retention_policy('docker_stats'") && t.includes("INTERVAL '24 hours'"),
    );
    expect(lastRefreshIdx).toBeGreaterThan(0);
    expect(rawRetentionIdx).toBeGreaterThan(lastRefreshIdx);
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

describe('splitSqlStatements', () => {
  test('splits on top-level semicolons and drops comment-only chunks', () => {
    const sql = [
      '-- migrate:no-transaction',
      'SELECT 1;',
      '',
      '/* block */',
      'SELECT 2;',
      '-- trailing comment',
    ].join('\n');

    expect(splitSqlStatements(sql)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  test('keeps a dollar-quoted body whole despite its inner semicolons', () => {
    const sql = "DO $$ BEGIN PERFORM 1; PERFORM 2; END $$;\nSELECT 3;";

    expect(splitSqlStatements(sql)).toEqual([
      'DO $$ BEGIN PERFORM 1; PERFORM 2; END $$',
      'SELECT 3',
    ]);
  });

  test('handles tagged dollar quotes', () => {
    const sql = "DO $body$ BEGIN PERFORM 1; END $body$;\nSELECT 2;";

    expect(splitSqlStatements(sql)).toEqual(['DO $body$ BEGIN PERFORM 1; END $body$', 'SELECT 2']);
  });

  test('ignores semicolons and comment markers inside string literals', () => {
    const sql = "SELECT 'a;b -- not a comment';\nSELECT 'it''s fine; really';";

    expect(splitSqlStatements(sql)).toEqual([
      "SELECT 'a;b -- not a comment'",
      "SELECT 'it''s fine; really'",
    ]);
  });

  test('ignores semicolons inside quoted identifiers', () => {
    expect(splitSqlStatements('SELECT "odd;name" FROM t;')).toEqual(['SELECT "odd;name" FROM t']);
  });

  test('returns a trailing statement that has no terminating semicolon', () => {
    expect(splitSqlStatements('SELECT 1;\nSELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  test('returns nothing for a file that is only comments', () => {
    expect(splitSqlStatements('-- just a note\n/* and another */\n')).toEqual([]);
  });
});
