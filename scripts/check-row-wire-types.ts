#!/usr/bin/env bun
/**
 * Asserts every `pool.query<Row>(...)` row interface against the result set Postgres
 * returns for that statement. Needs a reachable Postgres: it migrates a scratch database.
 *
 * bun scripts/check-row-wire-types.ts [--json <path>] [--type <RowType>] [--keep] [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import pg from 'pg';
import type { Pool } from 'pg';
import { createPool, recreateDatabase, waitForDatabase } from './migration-verify/db';

const REPO_ROOT = path.join(import.meta.dir, '..');
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

/** Narrowings the schema enforces and the wire cannot express, keyed `<file>|<RowType>.<field>`. An entry that stops matching a finding fails the check. */
const ALLOWED_NARROWINGS: Record<string, string> = {
  'src/lib/database/repositories/docker-container-event-repository.ts|ContainerEventQueryRow.state':
    'docker_container_events_fields_match_type CHECK: an upsert row always carries state, a destroy row always has NULL, and state is only read on the upsert branch',
  'src/lib/database/repositories/docker-container-event-repository.ts|ContainerEventQueryRow.name':
    'docker_container_events_fields_match_type CHECK: an upsert row always carries name, a destroy row always has NULL, and name is only read on the upsert branch',
  'src/lib/database/repositories/docker-container-event-repository.ts|ContainerEventQueryRow.image':
    'docker_container_events_fields_match_type CHECK: an upsert row always carries image, a destroy row always has NULL, and image is only read on the upsert branch',
};


const WIRE_TYPE_BY_PG_TYPE: Readonly<Record<string, string | undefined>> = {
  bool: 'boolean',
  int2: 'number',
  int4: 'number',
  int8: 'string', // parseBigInteger keeps BIGINT as a string to preserve precision
  oid: 'number',
  float4: 'number',
  float8: 'number',
  numeric: 'string', // numeric is arbitrary precision, so the driver does not narrow it
  money: 'string',
  text: 'string',
  varchar: 'string',
  bpchar: 'string',
  name: 'string',
  date: 'Date',
  timestamp: 'Date',
  timestamptz: 'Date',
  interval: 'PostgresInterval',
  bytea: 'Buffer',
  inet: 'string', // pg-types registers no parser, so the value passes through as text
  cidr: 'string',
  uuid: 'string',
  json: 'json',
  jsonb: 'json',
  _int2: 'number[]',
  _int4: 'number[]',
  _int8: 'string[]',
  _float4: 'number[]',
  _float8: 'number[]',
  _numeric: 'number[]',
  _text: 'string[]',
  _varchar: 'string[]',
  _bool: 'boolean[]',
  _date: 'Date[]',
  _timestamp: 'Date[]',
  _timestamptz: 'Date[]',
  _json: 'json',
  _jsonb: 'json',
};

const SAMPLE_BY_PG_TYPE: Readonly<Record<string, string | undefined>> = {
  bool: 't',
  int2: '1',
  int4: '1',
  int8: '1',
  oid: '1',
  float4: '1.5',
  float8: '1.5',
  numeric: '1.5',
  money: '1.5',
  text: 'x',
  varchar: 'x',
  bpchar: 'x',
  name: 'x',
  date: '2020-01-01',
  timestamp: '2020-01-01 00:00:00',
  timestamptz: '2020-01-01 00:00:00+00',
  interval: '1 day',
  bytea: '\\x41',
  inet: '192.168.1.5',
  cidr: '192.168.1.0/24',
  uuid: '00000000-0000-0000-0000-000000000000',
  json: '{"a":1}',
  jsonb: '{"a":1}',
  _int2: '{1,2}',
  _int4: '{1,2}',
  _int8: '{1,2}',
  _float4: '{1.5}',
  _float8: '{1.5}',
  _numeric: '{1.5}',
  _text: '{a,b}',
  _varchar: '{a,b}',
  _bool: '{t,f}',
  _date: '{2020-01-01}',
  _timestamp: '{2020-01-01 00:00:00}',
  _timestamptz: '{2020-01-01 00:00:00+00}',
  _json: '{"{\\"a\\":1}"}',
  _jsonb: '{"{\\"a\\":1}"}',
};

/** The runtime shape each wire type must parse to. Catches a table entry the driver stopped matching. */
const RUNTIME_SHAPE_BY_WIRE_TYPE: Readonly<Record<string, string[] | undefined>> = {
  boolean: ['boolean'],
  number: ['number'],
  string: ['string'],
  Date: ['Date'],
  Buffer: ['object'],
  PostgresInterval: ['object'],
  json: ['object', 'array'],
  'string[]': ['array'],
  'number[]': ['array'],
  'boolean[]': ['array'],
  'Date[]': ['array', 'Date[]'],
};

type TypeParser = (value: string) => unknown;

/** The pool's own parser instance, so a setTypeParser override is respected. */
const parserFor = (oid: number): TypeParser => pg.types.getTypeParser(oid, 'text') as TypeParser;

function runtimeTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Date) return 'Date';
  if (Array.isArray(value)) return value.every((entry) => entry instanceof Date) ? 'Date[]' : 'array';
  return typeof value;
}

/** Fails when the driver stops parsing a type the way the table above claims. */
function assertWireTypeTable(oidByPgTypeName: Map<string, number>): string[] {
  const problems: string[] = [];
  for (const pgType of Object.keys(WIRE_TYPE_BY_PG_TYPE)) {
    const expected = WIRE_TYPE_BY_PG_TYPE[pgType];
    if (expected === undefined) continue;
    const sample = SAMPLE_BY_PG_TYPE[pgType];
    if (sample === undefined) {
      problems.push(`${pgType}: no sample value, add one to SAMPLE_BY_PG_TYPE`);
      continue;
    }
    const oid = oidByPgTypeName.get(pgType);
    if (oid === undefined) {
      problems.push(`${pgType}: not a type name this database knows`);
      continue;
    }
    const actual = runtimeTypeOf(parserFor(oid)(sample));
    const shapes = RUNTIME_SHAPE_BY_WIRE_TYPE[expected];
    if (!shapes) {
      problems.push(`${expected}: no runtime shape declared, add one to RUNTIME_SHAPE_BY_WIRE_TYPE`);
      continue;
    }
    if (!shapes.includes(actual)) problems.push(`${pgType}: table says ${expected} (${shapes.join('/')}), driver parsed ${actual}`);
  }
  return problems;
}


interface RowField {
  name: string;
  type: string;
  optional: boolean;
}

interface QuerySite {
  file: string;
  line: number;
  rowType: string;
  rowFields: RowField[] | null;
  sql: string;
  dynamic: string[];
}

interface LocalType {
  members: readonly ts.TypeElement[];
  heritage: string[];
}

function scrapeFile(file: string): QuerySite[] {
  const text = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declared = new Map<string, LocalType>();

  const collectDeclarations = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node)) {
      declared.set(node.name.getText(sourceFile), {
        members: node.members,
        heritage: (node.heritageClauses ?? []).flatMap((clause) => clause.types.map((t) => t.expression.getText(sourceFile))),
      });
    }
    if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
      declared.set(node.name.getText(sourceFile), { members: node.type.members, heritage: [] });
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(sourceFile);

  const membersToFields = (members: readonly ts.TypeElement[]): RowField[] | null => {
    const fields: RowField[] = [];
    for (const member of members) {
      // An index signature means this is not a closed row: report nothing rather than every column.
      if (ts.isIndexSignatureDeclaration(member)) return null;
      if (!ts.isPropertySignature(member)) continue;
      fields.push({
        name: member.name.getText(sourceFile).replace(/['"]/g, ''),
        type: member.type ? member.type.getText(sourceFile).replace(/\s+/g, ' ') : 'any',
        optional: Boolean(member.questionToken),
      });
    }
    return fields;
  };

    const fieldsByName = (name: string, seen = new Set<string>()): RowField[] | null => {
    if (seen.has(name)) return null;
    seen.add(name);
    const local = declared.get(name);
    if (!local) return null;
    const fields = membersToFields(local.members);
    if (!fields) return null;
    for (const base of local.heritage) {
      const baseFields = fieldsByName(base, seen);
      if (baseFields) {
        for (const field of baseFields) {
          if (!fields.some((existing) => existing.name === field.name)) fields.push(field);
        }
      }
    }
    return fields;
  };

  const sites: QuerySite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.typeArguments?.length === 1) {
      const callee = node.expression.getText(sourceFile);
      if (/\.query$|\.queryOne$/.test(callee)) {
        const typeArgument = node.typeArguments[0];
        const argument = node.arguments.at(0);
        let sql: string | null = null;
        const dynamic: string[] = [];
        if (argument !== undefined && ts.isNoSubstitutionTemplateLiteral(argument)) {
          sql = argument.text;
        } else if (argument !== undefined && ts.isTemplateExpression(argument)) {
          let built = argument.head.text;
          for (const span of argument.templateSpans) {
            const expression = span.expression.getText(sourceFile);
            dynamic.push(expression);
            built += `<DYN:${expression}>${span.literal.text}`;
          }
          sql = built;
        }
        if (sql) {
          sites.push({
            file: path.relative(REPO_ROOT, file),
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            rowType: typeArgument.getText(sourceFile).replace(/\s+/g, ' '),
            rowFields: ts.isTypeReferenceNode(typeArgument)
              ? fieldsByName(typeArgument.typeName.getText(sourceFile))
              : ts.isTypeLiteralNode(typeArgument)
                ? membersToFields(typeArgument.members)
                : null,
            sql,
            dynamic: [...new Set(dynamic)],
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

function collectSites(): QuerySite[] {
  const sites: QuerySite[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(full);
      } else if (entry.name.endsWith('.ts')) {
        sites.push(...scrapeFile(full));
      }
    }
  };
  walk(DATABASE_DIR);
  return sites;
}


const TIER_BASE_BY_ROW_TYPE: Readonly<Record<string, string | undefined>> = {
  DockerStatsQueryRow: 'docker_stats',
  ZFSStatsQueryRow: 'zfs_stats',
  ProxmoxStatsQueryRow: 'proxmox_stats',
};

// A marker left over fails the run: the statement would otherwise be probed as something the repository does not run.
function resolveDynamicSql(sql: string): string {
  const nextParameter = [...sql.matchAll(/\$(\d+)/g)].reduce((max, m) => Math.max(max, Number(m[1])), 0) + 1;
  return sql
    .replace(/<DYN:boundsHostFilter>/g, `AND host = $${nextParameter}`)
    .replace(/<DYN:hostFilter>/g, `AND host = $${nextParameter}`)
    .replace(/<DYN:params\.length>/g, '1')
    .replace(/<DYN:setClauses\.join\(', '\)>/g, 'agent_version = $1')
    .replace(/<DYN:table>/g, 'docker_stats')
    .replace(/<DYN:op>/g, 'update')
    .replace(/<DYN:HOSTS_NOTIFY_CHANNEL>/g, 'hosts_changed');
}


interface ProbedColumn {
  name: string;
  pgType: string;
  wire?: string;
}

interface ProbeResult {
  columns?: ProbedColumn[];
  typeOids?: string[];
  error?: string;
}

async function probeSelect(pool: Pool, sql: string): Promise<ProbeResult> {
  const parameterCount = [...sql.matchAll(/\$(\d+)/g)].reduce((max, m) => Math.max(max, Number(m[1])), 0);
  const values = Array.from({ length: parameterCount }, () => null);
  const wrapped = `SELECT * FROM (\n${sql.replace(/;\s*$/, '')}\n) AS __row_wire_probe LIMIT 0`;
  try {
    const result = await pool.query({ text: wrapped, values });
    return { columns: result.fields.map((field) => ({ name: field.name, pgType: String(field.dataTypeID) })) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// PREPARE describes the statement. Executing it to learn the types would write.
async function probeDml(pool: Pool, sql: string): Promise<ProbeResult> {
  await pool.query('DEALLOCATE ALL');
  try {
    await pool.query(`PREPARE __row_wire_probe AS ${sql.replace(/;\s*$/, '')}`);
    const described = await pool.query<{ oids: number[] }>(
      `SELECT result_types::oid[] AS oids FROM pg_prepared_statements WHERE name = $1`,
      ['__row_wire_probe'],
    );
    if (!described.rows.length) return { error: 'PREPARE left no row in pg_prepared_statements' };
    return { typeOids: described.rows[0].oids.map(String) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    await pool.query('DEALLOCATE ALL').catch(() => undefined);
  }
}

function returningNames(sql: string, columnsOf: (table: string) => string[]): string[] | null {
  const match = /RETURNING\s+([\s\S]+?)\s*(?:;|$)/i.exec(sql);
  if (!match) return null;
  const names: string[] = [];
  for (const item of match[1].split(',').map((part) => part.trim()).filter(Boolean)) {
    if (item === '*') {
      const table = /\b(?:INSERT\s+INTO|UPDATE|FROM)\s+([a-z0-9_]+)/i.exec(sql)?.[1];
      if (!table) return null;
      names.push(...columnsOf(table));
      continue;
    }
    const alias = /\s+AS\s+([a-z0-9_]+)\s*$/i.exec(item);
    names.push((alias ? alias[1] : item.replace(/[()]/g, '').split('.').pop() ?? item).trim());
  }
  return names;
}


const PRIMITIVE_WIRE_TYPES = new Set(['number', 'string', 'boolean', 'Date', 'Buffer', 'PostgresInterval']);

interface DeclaredType {
  nullable: boolean;
  atoms: string[];
}

function parseDeclaredType(declared: string): DeclaredType {
  return {
    nullable: /(^|\W)null(\W|$)/.test(declared),
    atoms: declared
      .replace(/\bnull\b/g, '')
      .replace(/[()]/g, '')
      .split('|')
      .map((atom) => atom.trim())
      .filter(Boolean),
  };
}

type Verdict = 'unsound' | 'too-wide' | 'undeclared' | 'never-returned';

interface Finding {
  verdict: Verdict;
  file: string;
  line: number;
  rowType: string;
  field: string;
  declared?: string;
  wire?: string;
  detail: string;
}

interface ObservedField {
  wire: Set<string>;
  nullable: boolean | '?' | 'mixed';
  seen: number;
}

interface FieldContext {
  file: string;
  line: number;
  rowType: string;
}

function compareField(
  site: FieldContext,
  field: RowField,
  observed: ObservedField,
  requiredInAll: boolean,
): Finding[] {
  const findings: Finding[] = [];
  const wire = [...observed.wire];
  const { nullable, atoms } = parseDeclaredType(field.type);
  const jsonish = wire.includes('json');
  // json/jsonb parses into whatever the document holds, so a non-primitive declaration is a domain annotation.
  const acceptable = new Set([
    ...wire.filter((entry) => entry !== 'json'),
    ...(jsonish ? atoms.filter((atom) => !PRIMITIVE_WIRE_TYPES.has(atom)) : []),
  ]);
  const missing = wire.filter((entry) => entry !== 'json' && !atoms.includes(entry));
  const extra = atoms.filter((atom) => !acceptable.has(atom));
  const base = { file: site.file, line: site.line, rowType: site.rowType, field: field.name, declared: field.type, wire: wire.join(' | ') };

  if (missing.length) {
    findings.push({ ...base, verdict: 'unsound', detail: `the wire returns ${missing.join(', ')} and the declared type omits it` });
  } else if (extra.length) {
    findings.push({ ...base, verdict: 'too-wide', detail: `the declared type covers ${extra.join(', ')} which this column cannot produce` });
  }
  if (observed.nullable === true && !nullable) {
    findings.push({ ...base, verdict: 'unsound', detail: 'the column is nullable and the declared type has no null' });
  }
  if (observed.nullable === false && nullable) {
    findings.push({ ...base, verdict: 'too-wide', detail: 'the column is NOT NULL' });
  }
  if (requiredInAll && field.optional) {
    findings.push({ ...base, verdict: 'too-wide', detail: 'declared optional, but every projection of this row type returns it' });
  }
  if (!requiredInAll && !field.optional) {
    findings.push({ ...base, verdict: 'too-wide', detail: 'absent from at least one projection of this row type' });
  }
  return findings;
}


interface Catalog {
  columnsOf: (table: string) => string[];
  tablesIn: (sql: string) => string[];
  nullability: (column: string, tables: string[]) => boolean | '?';
}

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

    const sites = collectSites();
    const findings: Finding[] = [];
    const problems: string[] = [];
    const observedByRowType = new Map<
      string,
      { rowType: string; file: string; line: number; rowFields: RowField[] | null; fields: Map<string, ObservedField>; projections: Map<string, boolean>[] }
    >();
    let probed = 0;

    for (const site of sites) {
      const resolved = resolveDynamicSql(site.sql);
      const unresolved = /<DYN:(?!tier\.relation)[^>]+>/.exec(resolved);
      if (unresolved) {
        problems.push(`${site.file}:${site.line} [${site.rowType}] cannot be probed: unresolved ${unresolved[0]} in the SQL. Teach resolveDynamicSql about it.`);
        continue;
      }
      const isSelect = /^\s*(select|with)/i.test(resolved);
      const isReturningDml = /^\s*(insert|update|delete)/i.test(resolved) && /RETURNING/i.test(resolved);
      if (!isSelect && !isReturningDml) continue;

      const base = TIER_BASE_BY_ROW_TYPE[site.rowType] ?? 'docker_stats';
      const relations = resolved.includes('<DYN:tier.relation>')
        ? [base, `${base}_1m`, `${base}_1h_avg`]
        : [null];

      const projection = new Map<string, boolean>();
      let probeFailed = false;

      for (const relation of relations) {
        const sql = relation ? resolved.replace(/<DYN:tier\.relation>/g, relation) : resolved;
        const leftover = /<DYN:[^>]+>/.exec(sql);
        if (leftover) {
          problems.push(`${site.file}:${site.line} [${site.rowType}] cannot be probed: unresolved ${leftover[0]} in the SQL. Teach resolveDynamicSql about it.`);
          continue;
        }
        const result: ProbeResult = isSelect ? await probeSelect(pool, sql) : await probeDml(pool, sql);
        let columns: ProbedColumn[] | null = null;

        if (isSelect) {
          if (result.columns) columns = result.columns;
          else problems.push(`${site.file}:${site.line} [${site.rowType}] ${result.error ?? 'probe failed'} (relation ${relation ?? 'n/a'})`);
        } else if (result.typeOids) {
          const names = returningNames(sql, catalog.columnsOf);
          if (!names || names.length !== result.typeOids.length) {
            problems.push(`${site.file}:${site.line} [${site.rowType}] RETURNING names (${names?.join(',') ?? 'unresolved'}) do not line up with ${result.typeOids.length} reported types`);
          } else {
            columns = names.map((name, index) => ({ name, pgType: result.typeOids?.[index] ?? 'unknown' }));
          }
        } else {
          problems.push(`${site.file}:${site.line} [${site.rowType}] ${result.error ?? 'probe failed'}`);
        }

        if (!columns) {
          probeFailed = true;
          continue;
        }
        for (const column of columns) {
          const pgTypeName = pgTypeByOid.get(column.pgType) ?? column.pgType;
          column.wire = WIRE_TYPE_BY_PG_TYPE[pgTypeName];
          if (column.wire === undefined) {
            problems.push(`${site.file}:${site.line} [${site.rowType}] column ${column.name} is pg type ${pgTypeName}, which is not in WIRE_TYPE_BY_PG_TYPE`);
          }
        }
        probed += 1;
        for (const column of columns) projection.set(column.name, true);

        const key = `${site.file}|${site.rowType}`;
        if (!observedByRowType.has(key)) {
          observedByRowType.set(key, { rowType: site.rowType, file: site.file, line: site.line, rowFields: site.rowFields, fields: new Map(), projections: [] });
        }
        const observed = observedByRowType.get(key);
        if (!observed) continue;
        if (site.rowFields) observed.rowFields = site.rowFields;
        for (const column of columns) {
          const wire = column.wire ?? 'unknown';
          const slot = observed.fields.get(column.name) ?? { wire: new Set<string>(), nullable: '?' as boolean | '?' | 'mixed', seen: 0 };
          slot.wire.add(wire);
          slot.seen += 1;
          const nullable = catalog.nullability(column.name, catalog.tablesIn(sql));
          if (nullable !== '?') slot.nullable = slot.nullable === '?' || slot.nullable === nullable ? nullable : 'mixed';
          observed.fields.set(column.name, slot);
        }
      }
      if (probeFailed) continue;
      const key = `${site.file}|${site.rowType}`;
      const observed = observedByRowType.get(key);
      if (observed) observed.projections.push(projection);
    }

    for (const [key, observed] of [...observedByRowType].sort()) {
      if (ONLY_TYPE && observed.rowType !== ONLY_TYPE) continue;
      if (!observed.rowFields) {
        problems.push(`${key}: the row type could not be resolved from the type argument (an index signature or a type this script cannot follow)`);
        continue;
      }
      for (const [name, slot] of observed.fields) {
        const field = observed.rowFields.find((candidate) => candidate.name === name);
        if (!field) {
          findings.push({ verdict: 'undeclared', file: observed.file, line: observed.line, rowType: observed.rowType, field: name, wire: [...slot.wire].join(' | '), detail: 'the query returns this column and the row type does not declare it' });
          continue;
        }
        const requiredInAll = observed.projections.every((projection) => projection.has(name));
        findings.push(...compareField({ file: observed.file, line: observed.line, rowType: observed.rowType }, field, slot, requiredInAll));
      }
      for (const field of observed.rowFields) {
        if (!observed.fields.has(field.name) && !/^\[/.test(field.name)) {
          findings.push({ verdict: 'never-returned', file: observed.file, line: observed.line, rowType: observed.rowType, field: field.name, declared: field.type, detail: 'declared but no projection of this row type returns it' });
        }
      }
    }

    const allowed: { finding: Finding; reason: string }[] = [];
    const real: Finding[] = [];
    const usedAllowlistKeys = new Set<string>();
    for (const finding of findings) {
      const key = `${finding.file}|${finding.rowType}.${finding.field}`;
      const reason = ALLOWED_NARROWINGS[key];
      if (reason && finding.verdict === 'unsound') {
        allowed.push({ finding, reason });
        usedAllowlistKeys.add(key);
      } else {
        real.push(finding);
      }
    }
    const stale = Object.keys(ALLOWED_NARROWINGS).filter((key) => !usedAllowlistKeys.has(key));

    console.log(`row interfaces checked: ${observedByRowType.size} (${sites.length} query<Row> sites, ${probed} projections probed)`);
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
