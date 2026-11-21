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
import { collectSites } from './scrape';
import {
  isReturningDmlStatement,
  isSelectStatement,
  probeDml,
  probeSelect,
  resolveDynamicSql,
  returningNames,
  tierRelationsFor,
  type ProbeResult,
} from './probe';
import {
  ALLOWED_NARROWINGS,
  applyAllowlist,
  compareObservations,
  type ObservedRowType,
} from './compare';
import { observe, type Catalog } from './observe';
import { WIRE_TYPE_BY_PG_TYPE, assertWireTypeTable } from './wire-types';

const REPO_ROOT = path.join(import.meta.dir, '..', '..');
const DATABASE_DIR = path.join(REPO_ROOT, 'src/lib/database');
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

    const columnRows = await pool.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
    );
    const pgTypes = await pool.query<{ oid: string; typname: string }>(`SELECT oid::text AS oid, typname FROM pg_type`);
    const pgTypeByOid = new Map(pgTypes.rows.map((row) => [row.oid, row.typname]));
    const oidByPgTypeName = new Map(pgTypes.rows.map((row) => [row.typname, Number(row.oid)]));

    const wireTableProblems = assertWireTypeTable(oidByPgTypeName);
    if (wireTableProblems.length) {
      console.error('The wire-type table no longer matches the driver:');
      for (const problem of wireTableProblems) console.error(`  - ${problem}`);
      return 1;
    }

    const catalog: Catalog = {
      columnsOf: (table) => columnRows.rows.filter((row) => row.table_name === table).map((row) => row.column_name),
      tablesIn: (sql) => {
        const tables = new Set<string>();
        for (const match of sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z0-9_]+)/gi)) tables.add(match[1].toLowerCase());
        return [...tables];
      },
      nullability: (column, tables) => {
        const inQuery = columnRows.rows.filter((row) => row.column_name === column && tables.includes(row.table_name));
        const candidates = inQuery.length ? inQuery : columnRows.rows.filter((row) => row.column_name === column);
        const answers = new Set(candidates.map((row) => row.is_nullable));
        return answers.size === 1 ? [...answers][0] === 'YES' : '?';
      },
    };

    const sites = collectSites(DATABASE_DIR, REPO_ROOT);
    const problems: string[] = [];
    if (sites.length === 0) problems.push(`no query<Row> site found under ${path.relative(REPO_ROOT, DATABASE_DIR)}, so nothing was checked`);
    const observations = new Map<string, ObservedRowType>();
    let probed = 0;

    for (const site of sites) {
      if (site.sql === null) {
        problems.push(`${site.file}:${site.line} [${site.rowType}] cannot be probed: the statement is not a string, template or constant concatenation this script can read.`);
        continue;
      }
      const resolved = resolveDynamicSql(site.sql);
      const unresolved = /<DYN:(?!tier\.relation)[^>]+>/.exec(resolved);
      if (unresolved) {
        problems.push(`${site.file}:${site.line} [${site.rowType}] cannot be probed: unresolved ${unresolved[0]} in the SQL. Teach resolveDynamicSql about it.`);
        continue;
      }
      const isSelect = isSelectStatement(resolved);
      if (!isSelect && !isReturningDmlStatement(resolved)) {
        problems.push(`${site.file}:${site.line} [${site.rowType}] cannot be probed: only SELECT, WITH and INSERT/UPDATE/DELETE ... RETURNING statements are described.`);
        continue;
      }

      const projection = new Map<string, boolean>();
      let probeFailed = false;

      for (const relation of tierRelationsFor(resolved, site.rowType)) {
        const sql = relation ? resolved.replace(/<DYN:tier\.relation>/g, relation) : resolved;
        const leftover = /<DYN:[^>]+>/.exec(sql);
        if (leftover) {
          problems.push(`${site.file}:${site.line} [${site.rowType}] cannot be probed: unresolved ${leftover[0]} in the SQL. Teach resolveDynamicSql about it.`);
          continue;
        }
        const result: ProbeResult = isSelect ? await probeSelect(pool, sql) : await probeDml(pool, sql);
        let columns: { name: string; wire: string }[] | null = null;

        if (isSelect) {
          if (result.columns) {
            columns = result.columns.map((column) => ({ name: column.name, wire: WIRE_TYPE_BY_PG_TYPE[pgTypeByOid.get(column.pgType) ?? ''] ?? 'unknown' }));
            for (const column of result.columns) {
              const pgTypeName = pgTypeByOid.get(column.pgType) ?? column.pgType;
              if (WIRE_TYPE_BY_PG_TYPE[pgTypeName] === undefined) {
                problems.push(`${site.file}:${site.line} [${site.rowType}] column ${column.name} is pg type ${pgTypeName}, which is not in WIRE_TYPE_BY_PG_TYPE`);
              }
            }
          } else {
            problems.push(`${site.file}:${site.line} [${site.rowType}] ${result.error ?? 'probe failed'} (relation ${relation ?? 'n/a'})`);
          }
        } else if (result.typeOids) {
          const names = returningNames(sql, catalog.columnsOf);
          if (!names || names.length !== result.typeOids.length) {
            problems.push(`${site.file}:${site.line} [${site.rowType}] RETURNING names (${names?.join(',') ?? 'unresolved'}) do not line up with ${result.typeOids.length} reported types`);
          } else {
            columns = names.map((name, index) => ({
              name,
              wire: WIRE_TYPE_BY_PG_TYPE[pgTypeByOid.get(result.typeOids?.[index] ?? '') ?? ''] ?? 'unknown',
            }));
          }
        } else {
          problems.push(`${site.file}:${site.line} [${site.rowType}] ${result.error ?? 'probe failed'}`);
        }

        if (!columns) {
          probeFailed = true;
          continue;
        }
        probed += 1;
        for (const column of columns) projection.set(column.name, true);
        observe(observations, site, columns, sql, catalog);
      }
      if (probeFailed) continue;
      observations.get(`${site.file}|${site.rowType}`)?.projections.push(projection);
    }

    const compared = compareObservations(observations, ONLY_TYPE);
    problems.push(...compared.problems);
    const { allowed, real, stale } = applyAllowlist(compared.findings, ALLOWED_NARROWINGS);

    console.log(`row interfaces checked: ${observations.size} (${sites.length} query<Row> sites, ${probed} projections probed)`);
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
      console.log(`FAIL     ${key}: allowlisted as "${ALLOWED_NARROWINGS[key]}", but it no longer needs to be. Remove the entry.`);
    }

    if (JSON_OUT) {
      fs.writeFileSync(JSON_OUT, JSON.stringify({ findings: real, allowed, problems, stale, sites: sites.length, probed }, null, 2));
      console.log(`\nwrote ${JSON_OUT}`);
    }

    if (real.length || problems.length || stale.length) {
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
