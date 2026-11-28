#!/usr/bin/env bun
/**
 * Asserts every `pool.query<Row>(...)` row interface against the result set Postgres
 * returns for that statement. Needs a reachable Postgres: it migrates a scratch database.
 *
 * bun scripts/row-wire-types/run.ts [--json <path>] [--type <RowType>] [--keep] [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createPool, recreateDatabase, waitForDatabase } from '../migration-verify/db';
import { scanSources } from './scrape';
import { ALLOWED_NARROWINGS } from './compare';
import { checkSites, evaluate } from './check';
import type { AttributeCatalog } from './nullability';
import { assertWireTypeTable } from './wire-types';

const REPO_ROOT = path.join(import.meta.dir, '..', '..');
const SCAN_DIRS = [path.join(REPO_ROOT, 'src'), path.join(REPO_ROOT, 'server')];
const SCRATCH_DATABASE = process.env.ROW_TYPE_DATABASE ?? 'rowtype_check';

const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
const VERBOSE = argv.includes('--verbose');
const KEEP_DATABASE = argv.includes('--keep');
const ONLY_TYPE = flagValue('--type');
const JSON_OUT = flagValue('--json');

async function main(): Promise<number> {
  await waitForDatabase();
  await recreateDatabase(SCRATCH_DATABASE);
  const pool = createPool(SCRATCH_DATABASE);
  try {
    const { runMigrations } = await import('@/lib/database/migrate');
    const adapter = { getPool: () => pool } as unknown as Parameters<typeof runMigrations>[0];
    await runMigrations(adapter);

    const pgTypes = await pool.query<{ oid: string; typname: string }>(`SELECT oid::text AS oid, typname FROM pg_type`);
    const pgTypeByOid = new Map(pgTypes.rows.map((row) => [row.oid, row.typname]));
    const oidByPgTypeName = new Map(pgTypes.rows.map((row) => [row.typname, Number(row.oid)]));

    const wireTableProblems = assertWireTypeTable(oidByPgTypeName);
    if (wireTableProblems.length) {
      console.error('The wire-type table no longer matches the driver:');
      for (const problem of wireTableProblems) console.error(`  - ${problem}`);
      return 1;
    }

    const attributes = await pool.query<{ oid: number; relname: string; relkind: string; attnum: number; attname: string; attnotnull: boolean }>(
      `SELECT c.oid::int AS oid, c.relname, c.relkind::text AS relkind, a.attnum::int AS attnum, a.attname, a.attnotnull
         FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE c.relnamespace = 'public'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY c.relname, a.attnum`,
    );
    const catalog: AttributeCatalog = {
      relation: (oid) => {
        const row = attributes.rows.find((candidate) => candidate.oid === oid);
        return row ? { name: row.relname, kind: row.relkind } : undefined;
      },
      attributeNotNull: (oid, attnum) => attributes.rows.find((row) => row.oid === oid && row.attnum === attnum)?.attnotnull,
      columnsOf: (table) => attributes.rows.filter((row) => row.relname === table).map((row) => row.attname),
      columnNotNull: (table, column) => attributes.rows.find((row) => row.relname === table && row.attname === column)?.attnotnull,
    };

    const scan = scanSources(SCAN_DIRS, REPO_ROOT, { tsconfig: path.join(REPO_ROOT, 'tsconfig.json') });
    const { sites } = scan;
    const result = await checkSites(sites, { pool, pgTypeByOid, catalog });
    const evaluation = evaluate(result, scan, ALLOWED_NARROWINGS, ONLY_TYPE);
    const { allowed, real, stale, problems } = evaluation;

    console.log(`row interfaces checked: ${result.observations.size} (${sites.length} query<Row> sites, ${result.probed} projections probed)`);
    console.log(`allowlisted narrowings: ${allowed.length} of ${Object.keys(ALLOWED_NARROWINGS).length}`);
    console.log('');

    for (const { finding, reason } of allowed) {
      console.log(`allowed  ${finding.file}:${finding.line} ${finding.rowType}.${finding.field}: declared ${finding.declared}, wire ${finding.wire}`);
      if (VERBOSE) console.log(`         ${reason}`);
    }
    for (const problem of problems) console.log(`probe    ${problem}`);
    for (const finding of real) {
      console.log(`FAIL     ${finding.file}:${finding.line} ${finding.rowType}.${finding.field}: declared ${finding.declared ?? '(undeclared)'}, wire ${finding.wire ?? '-'}`);
      console.log(`         ${finding.verdict}: ${finding.detail}`);
    }
    for (const key of stale) {
      console.log(`FAIL     ${key}: allowlisted as "${ALLOWED_NARROWINGS[key]?.reason}", but no finding matches its declared and wire types any more. Remove or update the entry.`);
    }

    if (JSON_OUT) {
      fs.writeFileSync(JSON_OUT, JSON.stringify({ findings: real, allowed, problems, stale, sites: sites.length, probed: result.probed }, null, 2));
      console.log(`\nwrote ${JSON_OUT}`);
    }

    if (evaluation.failed) {
      console.log('');
      console.log(`${real.length} field(s) do not match the wire, ${problems.length} statement(s) could not be probed, ${stale.length} stale allowlist entr(ies).`);
      console.log('Fix by narrowing the declared type to what the column returns, or by casting in the SQL so the');
      console.log('column has one wire type across every tier. A genuinely narrower type (a CHECK constraint) goes in');
      console.log('ALLOWED_NARROWINGS with the constraint named.');
      return 1;
    }
    console.log('every row interface matches the wire.');
    return 0;
  } finally {
    await pool.end();
    if (!KEEP_DATABASE) {
      const admin = createPool('postgres');
      await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DATABASE}" WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    }
  }
}

process.exit(await main());
