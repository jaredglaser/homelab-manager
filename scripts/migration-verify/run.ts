#!/usr/bin/env bun
/**
 * Runs migrations/ against a real TimescaleDB and asserts the result.
 *
 * Scenarios:
 *   fresh       apply every migration to an empty database, assert the schema
 *   upgrade     apply the merge-base migrations, seed data, apply the rest, run the rollup
 *               backfill, assert nothing was lost and the aggregation rules still hold
 *   idempotent  apply the full set twice, assert the second run applies nothing
 *
 * The idempotent scenario relies on the migration ledger, so it cannot observe
 * whether an individual statement tolerates re-execution. That only matters if
 * the runner regains a no-transaction mode: without a rollback, a mid-file
 * failure leaves partial state and the whole file re-runs on the next boot, so
 * every statement in such a file has to be individually idempotent. No runner
 * mode and no migration has that property today.
 *
 * MIGRATION_BASE_ROOT points at a checkout of the merge-base commit. The
 * upgrade scenario imports that checkout's own migrate.ts, which resolves its
 * migrations directory relative to itself, so the pre-upgrade state is produced
 * by the runner as it existed at the base commit rather than by a reimplementation.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import type { DatabaseClient } from '@/lib/clients/database-client';
import { runMigrations } from '@/lib/database/migrate';
import { runStatsRollupBackfill } from '@/lib/database/stats-rollup-backfill';
import {
  assertAggregateRegistry,
  assertAggregateSources,
  assertAggregateTierValues,
  assertCumulativeCounters,
  assertHourlyAverageViews,
  assertIdleContainerIdentity,
  assertNullMetricDilution,
  assertRollupBackfill,
  assertRowCountsPreserved,
  assertSchema,
  assertTierColumnCoverage,
  assertWeightedRollup,
  captureRowCounts,
} from './assertions';
import { Checks } from './checks';
import { createPool, recreateDatabase, waitForDatabase } from './db';
import { seed } from './seed';

type MigrationRunner = (db: DatabaseClient) => Promise<void>;

const REPO_ROOT = join(import.meta.dir, '..', '..');
const DB_PREFIX = process.env.MIGRATION_DB_PREFIX ?? 'migverify';

async function main(): Promise<void> {
  const scenario = process.argv[2];
  await waitForDatabase();

  switch (scenario) {
    case 'fresh':
      await runFresh();
      break;
    case 'upgrade':
      await runUpgrade();
      break;
    case 'idempotent':
      await runIdempotent();
      break;
    default:
      throw new Error(`Unknown scenario "${scenario ?? ''}". Use fresh, upgrade or idempotent.`);
  }
}

async function runFresh(): Promise<void> {
  const checks = new Checks('fresh');
  const pool = await freshDatabase('fresh');
  try {
    await runMigrations(asDatabaseClient(pool));

    const applied = await appliedMigrations(pool);
    checks.sameSet('every migration file was applied', applied, migrationFiles(REPO_ROOT));

    await assertSchema(pool, checks);
    await assertAggregateRegistry(pool, checks);
    await assertAggregateSources(pool, checks);
    await assertTierColumnCoverage(pool, checks);
    checks.report();
  } finally {
    await pool.end();
  }
}

async function runUpgrade(): Promise<void> {
  const checks = new Checks('upgrade');
  const baseRoot = process.env.MIGRATION_BASE_ROOT;
  const pool = await freshDatabase('upgrade');

  try {
    const baseFiles = baseRoot ? migrationFiles(baseRoot) : migrationFiles(REPO_ROOT);
    const headFiles = migrationFiles(REPO_ROOT);
    const added = headFiles.filter(file => !baseFiles.includes(file));
    const removed = baseFiles.filter(file => !headFiles.includes(file));

    console.info(
      `[upgrade] base has ${baseFiles.length} migrations, head has ${headFiles.length}` +
        ` (added: ${added.join(', ') || 'none'}; removed: ${removed.join(', ') || 'none'})`
    );
    if (!baseRoot) {
      console.info('[upgrade] MIGRATION_BASE_ROOT unset, base and head are the same revision');
    }

    const baseRunner = baseRoot ? await loadBaseRunner(baseRoot) : runMigrations;
    await baseRunner(asDatabaseClient(pool));
    const ledgerBefore = await appliedMigrations(pool);
    checks.sameSet('base revision applied its own migrations', ledgerBefore, baseFiles);

    await seed(pool);
    const before = await captureRowCounts(pool);
    console.info(`[upgrade] seeded ${Object.values(before).reduce((a, b) => a + b, 0)} rows`);

    await runMigrations(asDatabaseClient(pool));
    const ledgerAfter = await appliedMigrations(pool);
    checks.containsAll('head migrations are all recorded', ledgerAfter, headFiles);
    checks.sameSet(
      'upgrade applied exactly the new migrations',
      ledgerAfter.filter(name => !ledgerBefore.includes(name)),
      added
    );

    const after = await captureRowCounts(pool);
    assertRowCountsPreserved(before, after, checks);

    await assertSchema(pool, checks);
    await assertIdleContainerIdentity(pool, checks);

    // Both of the above read state the backfill changes: it adds the retention policies that
    // assertSchema requires the migrations not to add, and raw retention covers the 31-day-old
    // rows assertIdleContainerIdentity resolves a name from.
    const swallowed = await runBackfillCapturingFailures(pool);
    checks.equal(
      'the rollup backfill reported no per-source failure',
      swallowed.join(' | ') || 'none',
      'none'
    );

    // Registry and column coverage first: they name the views every later assertion queries by
    // interpolation, so a missing or renamed one reports as a failed check instead of a throw.
    await assertAggregateRegistry(pool, checks);
    await assertAggregateSources(pool, checks);
    await assertTierColumnCoverage(pool, checks);
    await assertRollupBackfill(pool, checks);
    await assertWeightedRollup(pool, checks);
    await assertCumulativeCounters(pool, checks);
    await assertNullMetricDilution(pool, checks);
    await assertAggregateTierValues(pool, checks);
    await assertHourlyAverageViews(pool, checks);
    checks.report();
  } finally {
    await pool.end();
  }
}

async function runIdempotent(): Promise<void> {
  const checks = new Checks('idempotent');
  const pool = await freshDatabase('idempotent');
  try {
    await runMigrations(asDatabaseClient(pool));
    const first = await migrationLedger(pool);
    checks.equal('first run applied every migration', first.length, migrationFiles(REPO_ROOT).length);

    await runMigrations(asDatabaseClient(pool));
    const second = await migrationLedger(pool);

    checks.equal('second run applied nothing new', second.length, first.length);
    checks.sameSet(
      'second run left the ledger unchanged',
      second.map(entry => `${entry.name}@${entry.executedAt}`),
      first.map(entry => `${entry.name}@${entry.executedAt}`)
    );

    checks.report();
  } finally {
    await pool.end();
  }
}

/**
 * `backfillSource` catches per-source failures and only skips that source's retention, so a refresh
 * that lost a race with the scheduled refresh policy surfaces downstream as a missing retention
 * policy and points at the wrong thing. Its one signal is the console.error it logs; capturing that
 * turns the real cause into a named check while leaving the message in the job log.
 */
async function runBackfillCapturingFailures(pool: Pool): Promise<string[]> {
  const swallowed: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    swallowed.push(args.map(arg => String(arg)).join(' '));
    original(...args);
  };
  try {
    await runStatsRollupBackfill(asDatabaseClient(pool));
  } finally {
    console.error = original;
  }
  return swallowed;
}

async function freshDatabase(suffix: string): Promise<Pool> {
  const name = `${DB_PREFIX}_${suffix}`;
  await recreateDatabase(name);
  return createPool(name);
}

async function loadBaseRunner(baseRoot: string): Promise<MigrationRunner> {
  const modulePath = pathToFileURL(join(baseRoot, 'src', 'lib', 'database', 'migrate.ts')).href;
  const loaded = (await import(modulePath)) as { runMigrations?: MigrationRunner };
  if (typeof loaded.runMigrations !== 'function') {
    throw new Error(`No runMigrations export found at ${modulePath}`);
  }
  return loaded.runMigrations;
}

function migrationFiles(root: string): string[] {
  return readdirSync(join(root, 'migrations'))
    .filter(file => file.endsWith('.sql'))
    .sort();
}

async function appliedMigrations(pool: Pool): Promise<string[]> {
  const result = await pool.query('SELECT name FROM migrations ORDER BY id');
  return result.rows.map(row => row.name as string);
}

async function migrationLedger(pool: Pool): Promise<Array<{ name: string; executedAt: string }>> {
  const result = await pool.query('SELECT name, executed_at FROM migrations ORDER BY id');
  return result.rows.map(row => ({
    name: row.name as string,
    executedAt: new Date(row.executed_at).toISOString(),
  }));
}

function asDatabaseClient(pool: Pool): DatabaseClient {
  return { getPool: () => pool } as unknown as DatabaseClient;
}

await main();
