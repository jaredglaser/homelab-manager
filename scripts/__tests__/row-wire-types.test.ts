import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import {
  RUNTIME_SHAPE_BY_WIRE_TYPE,
  SAMPLE_BY_PG_TYPE,
  WIRE_TYPE_BY_PG_TYPE,
  assertWireTypeTable,
  parserFor,
  runtimeTypeOf,
} from '../row-wire-types/wire-types';
import { collectSites, collectUntypedReads, scrapeFile, scrapeUntypedReads, type QuerySite } from '../row-wire-types/scrape';
import { observe } from '../row-wire-types/observe';
import { MIN_QUERY_SITES } from '../row-wire-types/floor';
import { outerJoinedTables, returningNullability, selectNullability, type AttributeCatalog } from '../row-wire-types/nullability';
import { checkSites, evaluate } from '../row-wire-types/check';
import {
  isReturningDmlStatement,
  isSelectStatement,
  probeDml,
  probeSelect,
  resolveDynamicSql,
  returningItems,
  returningNames,
  tierRelationsFor,
} from '../row-wire-types/probe';
import {
  applyAllowlist,
  compareField,
  compareObservations,
  parseDeclaredType,
  type AllowedNarrowing,
  type Finding,
  type ObservedField,
  type ObservedRowType,
} from '../row-wire-types/compare';

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'row-wire-types-'));
afterAll(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

function fixture(name: string, source: string): string {
  const file = path.join(fixtureDir, name);
  fs.writeFileSync(file, source);
  return file;
}

function observed(wire: string[], nullable: ObservedField['nullable'] = '?'): ObservedField {
  return { wire: new Set(wire), nullable, seen: 1 };
}

describe('wire-type table', () => {
  test('every mapped type has a sample and a runtime shape, so the table can be proved row by row', () => {
    const missingSamples = Object.keys(WIRE_TYPE_BY_PG_TYPE).filter((pgType) => SAMPLE_BY_PG_TYPE[pgType] === undefined);
    const missingShapes = Object.entries(WIRE_TYPE_BY_PG_TYPE)
      .filter(([, wire]) => wire !== undefined && RUNTIME_SHAPE_BY_WIRE_TYPE[wire] === undefined)
      .map(([pgType]) => pgType);
    expect(missingSamples).toEqual([]);
    expect(missingShapes).toEqual([]);
  });

  test('maps the types the repositories actually read', () => {
    expect(WIRE_TYPE_BY_PG_TYPE.int4).toBe('number');
    expect(WIRE_TYPE_BY_PG_TYPE.int8).toBe('string');
    expect(WIRE_TYPE_BY_PG_TYPE.numeric).toBe('string');
    expect(WIRE_TYPE_BY_PG_TYPE.bool).toBe('boolean');
    expect(WIRE_TYPE_BY_PG_TYPE.timestamptz).toBe('Date');
    expect(WIRE_TYPE_BY_PG_TYPE.jsonb).toBe('json');
    expect(WIRE_TYPE_BY_PG_TYPE.inet).toBe('string');
    expect(WIRE_TYPE_BY_PG_TYPE._int4).toBe('number[]');
    expect(WIRE_TYPE_BY_PG_TYPE._text).toBe('string[]');
  });

  test('the driver really parses int4 as a number and int8 as a string', () => {
    expect(runtimeTypeOf(parserFor(23)('42'))).toBe('number');
    expect(runtimeTypeOf(parserFor(20)('42'))).toBe('string');
  });

  test('reports every entry it cannot prove against the catalog', () => {
    const problems = assertWireTypeTable(new Map());
    expect(problems).toHaveLength(Object.keys(WIRE_TYPE_BY_PG_TYPE).length);
    expect(problems[0]).toContain('not a type name this database knows');
  });

  test('names the runtime shape of a parsed value, including dates and arrays', () => {
    expect(runtimeTypeOf(null)).toBe('null');
    expect(runtimeTypeOf(new Date(0))).toBe('Date');
    expect(runtimeTypeOf([new Date(0)])).toBe('Date[]');
    expect(runtimeTypeOf([1, 2])).toBe('array');
    expect(runtimeTypeOf('x')).toBe('string');
  });
});

describe('scrapeFile', () => {
  test('collects a query<Row> site with its row type, sql and relative path', () => {
    const file = fixture('site.ts', [
      'interface IdRow {',
      '  id: number;',
      '}',
      'class Repo {',
      '  async read() {',
      '    return this.pool.query<IdRow>(`SELECT id FROM deploy_history WHERE host = $1`, [this.host]);',
      '  }',
      '}',
    ].join('\n'));
    const sites = scrapeFile(file, fixtureDir);
    expect(sites).toHaveLength(1);
    expect(sites[0].file).toBe('site.ts');
    expect(sites[0].rowType).toBe('IdRow');
    expect(sites[0].sql).toContain('SELECT id FROM deploy_history');
    expect(sites[0].rowFields).toEqual([{ name: 'id', type: 'number', optional: false }]);
  });

  test('follows an extends chain so inherited columns are checked too', () => {
    const file = fixture('extends.ts', [
      'interface BaseRow {',
      '  id: number;',
      '  user_id: number;',
      '}',
      'interface ChildRow extends BaseRow {',
      '  label: string;',
      '  last_used_at: Date | null;',
      '}',
      'const q = pool.query<ChildRow>(`SELECT id, user_id, label, last_used_at FROM git_tokens`);',
    ].join('\n'));
    const [site] = scrapeFile(file, fixtureDir);
    expect(site.rowFields?.map((field) => field.name)).toEqual(['label', 'last_used_at', 'id', 'user_id']);
  });

  test('reports no fields for a row type with an index signature', () => {
    const file = fixture('open.ts', [
      'interface OpenRow {',
      '  [column: string]: unknown;',
      '}',
      'const q = pool.query<OpenRow>(`SELECT * FROM whatever`);',
    ].join('\n'));
    const [site] = scrapeFile(file, fixtureDir);
    expect(site.rowType).toBe('OpenRow');
    expect(site.rowFields).toBeNull();
  });

  test('keeps an interpolated statement and records the expression it interpolates', () => {
    const file = fixture('dynamic.ts', [
      'interface IdRow { id: number }',
      'const q = pool.query<IdRow>(`SELECT id FROM ${tier.relation} WHERE time > $1`, [seconds]);',
    ].join('\n'));
    const [site] = scrapeFile(file, fixtureDir);
    expect(site.sql).toContain('<DYN:tier.relation>');
    expect(site.dynamic).toEqual(['tier.relation']);
  });

  test('reads a plain string literal statement', () => {
    const file = fixture('plain.ts', [
      'interface IdRow { id: number }',
      "const a = pool.query<IdRow>('SELECT id FROM users WHERE id = $1', [id]);",
    ].join('\n'));
    expect(scrapeFile(file, fixtureDir)[0].sql).toBe('SELECT id FROM users WHERE id = $1');
  });

  test('joins a concatenation, following a top-level const', () => {
    const file = fixture('concat.ts', [
      'interface IdRow { id: number }',
      "const COLUMNS = 'id, name';",
      "const a = pool.query<IdRow>('SELECT ' + COLUMNS + ' FROM users');",
    ].join('\n'));
    expect(scrapeFile(file, fixtureDir)[0].sql).toBe('SELECT id, name FROM users');
  });

  test('keeps a site whose statement it cannot read, with a null statement, so the run can fail on it', () => {
    const file = fixture('opaque.ts', [
      'interface IdRow { id: number }',
      'const a = pool.query<IdRow>(buildSql(), []);',
      "const b = pool.query<IdRow>({ text: 'SELECT 1' });",
      "const c = pool.query<IdRow>('SELECT ' + unknownName);",
    ].join('\n'));
    expect(scrapeFile(file, fixtureDir).map((site) => site.sql)).toEqual([null, null, null]);
  });

  test('ignores calls that are not a typed query', () => {
    const file = fixture('other.ts', [
      'interface IdRow { id: number }',
      'const a = pool.query(`SELECT 1`);',
      'const b = pool.query<IdRow, Extra>(`SELECT 2`);',
      'const c = other.read<IdRow>(`SELECT 3`);',
    ].join('\n'));
    expect(scrapeFile(file, fixtureDir)).toEqual([]);
  });

  test('collectSites skips test directories', () => {
    const dir = fs.mkdtempSync(path.join(fixtureDir, 'tree-'));
    fs.mkdirSync(path.join(dir, '__tests__'));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'interface IdRow { id: number }\nconst q = pool.query<IdRow>(`SELECT 1`);');
    fs.writeFileSync(path.join(dir, '__tests__', 'a.test.ts'), 'interface IdRow { id: number }\nconst q = pool.query<IdRow>(`SELECT 1`);');
    expect(collectSites(dir, dir).map((site) => site.file)).toEqual(['a.ts']);
  });
});

describe('resolveDynamicSql', () => {
  test('gives an interpolated host filter the next free parameter index', () => {
    const resolved = resolveDynamicSql('SELECT 1 FROM t WHERE time > $1 AND container_id = ANY($3) <DYN:boundsHostFilter>');
    expect(resolved).toBe('SELECT 1 FROM t WHERE time > $1 AND container_id = ANY($3) AND host = $4');
  });

  test('instantiates the set-clause and table markers', () => {
    expect(resolveDynamicSql('UPDATE t SET <DYN:setClauses.join(\', \')> WHERE id = $<DYN:params.length>')).toBe(
      'UPDATE t SET agent_version = $1 WHERE id = $1',
    );
    expect(resolveDynamicSql('SELECT 1 FROM <DYN:table>')).toBe('SELECT 1 FROM docker_stats');
  });

  test('leaves an unknown marker in place so the caller can refuse the statement', () => {
    expect(resolveDynamicSql('SELECT 1 FROM t <DYN:mystery>')).toContain('<DYN:mystery>');
  });
});

describe('statement shape', () => {
  test('classifies selects, CTEs and RETURNING dml', () => {
    expect(isSelectStatement('SELECT * FROM t')).toBe(true);
    expect(isSelectStatement('  \n WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true);
    expect(isSelectStatement('UPDATE t SET a = 1 RETURNING a')).toBe(false);
    expect(isReturningDmlStatement('UPDATE t SET a = 1 RETURNING a')).toBe(true);
    expect(isReturningDmlStatement('DELETE FROM t RETURNING id')).toBe(true);
    expect(isReturningDmlStatement('INSERT INTO t (a) VALUES ($1)')).toBe(false);
    expect(isReturningDmlStatement('SELECT * FROM t')).toBe(false);
  });

  test('a tier-interpolating row type is probed against all three relations', () => {
    expect(tierRelationsFor('SELECT * FROM <DYN:tier.relation>', 'ProxmoxStatsQueryRow')).toEqual([
      'proxmox_stats',
      'proxmox_stats_1m',
      'proxmox_stats_1h_avg',
    ]);
    expect(tierRelationsFor('SELECT * FROM zfs_stats', 'ZFSStatsQueryRow')).toEqual([null]);
  });

  test('expands a RETURNING list, including *', () => {
    expect(returningNames('DELETE FROM deploy_queue WHERE x = 1 RETURNING request, queued_at', () => [])).toEqual(['request', 'queued_at']);
    expect(returningNames('UPDATE managed_hosts SET a = 1 RETURNING *', () => ['id', 'name', 'status'])).toEqual(['id', 'name', 'status']);
    expect(returningNames('UPDATE t SET a = 1 RETURNING count(*) AS total', () => [])).toEqual(['total']);
    expect(returningNames('INSERT INTO t (a) VALUES ($1)', () => [])).toBeNull();
  });
});

describe('parseDeclaredType', () => {
  test('splits atoms and spots null', () => {
    expect(parseDeclaredType('number | string')).toEqual({ nullable: false, atoms: ['number', 'string'] });
    expect(parseDeclaredType('string | null')).toEqual({ nullable: true, atoms: ['string'] });
    expect(parseDeclaredType('Record<string, string> | null')).toEqual({ nullable: true, atoms: ['Record<string, string>'] });
  });
});

describe('compareField', () => {
  const site = { file: 'repo.ts', line: 1, rowType: 'Row' };
  const cases: { name: string; declared: string; wire: string[]; nullable: ObservedField['nullable']; requiredInAll: boolean; optional?: boolean; verdicts: Finding['verdict'][] }[] = [
    { name: 'a covering union', declared: 'number | string', wire: ['number'], nullable: false, requiredInAll: true, verdicts: ['too-wide'] },
    { name: 'a type that omits what the wire returns', declared: 'number', wire: ['string'], nullable: '?', requiredInAll: true, verdicts: ['unsound'] },
    { name: 'a nullable column with no null in the type', declared: 'string', wire: ['string'], nullable: true, requiredInAll: true, verdicts: ['unsound'] },
    { name: 'a NOT NULL column declared nullable', declared: 'string | null', wire: ['string'], nullable: false, requiredInAll: true, verdicts: ['too-wide'] },
    { name: 'a field every projection returns, declared optional', declared: 'string', wire: ['string'], nullable: false, requiredInAll: true, optional: true, verdicts: ['too-wide'] },
    { name: 'a field one projection omits, declared required', declared: 'string', wire: ['string'], nullable: false, requiredInAll: false, verdicts: ['too-wide'] },
    { name: 'an exact match', declared: 'number | null', wire: ['number'], nullable: true, requiredInAll: true, verdicts: [] },
    { name: 'a domain annotation on a json column', declared: 'DeployRequest', wire: ['json'], nullable: false, requiredInAll: true, verdicts: [] },
    { name: 'a primitive declared on a json column', declared: 'string', wire: ['json'], nullable: '?', requiredInAll: true, verdicts: ['too-wide'] },
    { name: 'two tiers that disagree with a narrow type', declared: 'number | null', wire: ['string', 'number'], nullable: '?', requiredInAll: true, verdicts: ['unsound'] },
  ];

  for (const testCase of cases) {
    test(`${testCase.declared} against wire ${testCase.wire.join('|')}: ${testCase.name}`, () => {
      const findings = compareField(
        site,
        { name: 'column', type: testCase.declared, optional: Boolean(testCase.optional) },
        observed(testCase.wire, testCase.nullable),
        testCase.requiredInAll,
      );
      expect(findings.map((finding) => finding.verdict)).toEqual(testCase.verdicts);
    });
  }
});

describe('compareObservations', () => {
  function observations(fields: Record<string, ObservedField>, rowFields: ObservedRowType['rowFields'], projections: Map<string, boolean>[]): Map<string, ObservedRowType> {
    return new Map([
      ['repo.ts|Row', { rowType: 'Row', file: 'repo.ts', line: 7, rowFields, fields: new Map(Object.entries(fields)), projections }],
    ]);
  }

  test('flags a column the row type does not declare', () => {
    const { findings } = compareObservations(observations({ id: observed(['number'], false) }, [], [new Map([['id', true]])]));
    expect(findings.map((finding) => finding.verdict)).toEqual(['undeclared']);
  });

  test('flags a declared field no projection returns', () => {
    const { findings } = compareObservations(observations({}, [{ name: 'started_at', type: 'Date | null', optional: true }], [new Map<string, boolean>()]));
    expect(findings.map((finding) => finding.verdict)).toEqual(['never-returned']);
  });

  test('uses every projection of a shared row type to decide optionality', () => {
    const first = new Map([['id', true], ['host', true]]);
    const second = new Map([['id', true]]);
    const fields = { id: observed(['number'], false), host: observed(['string'], false) };
    const rowFields = [
      { name: 'id', type: 'number', optional: false },
      { name: 'host', type: 'string', optional: true },
    ];
    expect(compareObservations(observations(fields, rowFields, [first, second])).findings).toEqual([]);
  });

  test('reports a row type it could not resolve instead of every column', () => {
    const { findings, problems } = compareObservations(observations({ id: observed(['number'], false) }, null, [new Map([['id', true]])]));
    expect(findings).toEqual([]);
    expect(problems[0]).toContain('could not be resolved from the type argument');
  });

  test('onlyType narrows the comparison to one row type', () => {
    expect(compareObservations(observations({ id: observed(['number'], false) }, [], []), 'OtherRow').findings).toEqual([]);
  });
});

describe('applyAllowlist', () => {
  const finding = (verdict: Finding['verdict'], overrides: Partial<Finding> = {}): Finding => ({
    verdict,
    file: 'repo.ts',
    line: 1,
    rowType: 'Row',
    field: 'state',
    declared: 'string',
    wire: 'string',
    detail: 'the column is nullable and the declared type has no null',
    ...overrides,
  });
  const reason = 'CHECK keeps it set on the branch that reads it';
  const entry: Record<string, AllowedNarrowing> = { 'repo.ts|Row.state': { reason, declared: 'string', wire: 'string' } };

  test('suppresses an unsound finding the entry names', () => {
    const { allowed, real, stale } = applyAllowlist([finding('unsound')], entry);
    expect(allowed).toHaveLength(1);
    expect(allowed[0].reason).toBe(reason);
    expect(real).toEqual([]);
    expect(stale).toEqual([]);
  });

  test('with a row type filter only that type\'s entries can be stale', () => {
    const entries = { ...entry, 'other.ts|Other.state': { reason, declared: 'string', wire: 'string' } };
    expect(applyAllowlist([], entries, 'Row').stale).toEqual(['repo.ts|Row.state']);
    expect(applyAllowlist([], entries, 'Other').stale).toEqual(['other.ts|Other.state']);
    expect(applyAllowlist([], entries, 'Unrelated').stale).toEqual([]);
    expect(applyAllowlist([], entries).stale).toEqual(['repo.ts|Row.state', 'other.ts|Other.state']);
  });

  test('an entry that stops matching a finding is stale, so it cannot rot into an exemption', () => {
    expect(applyAllowlist([], entry).stale).toEqual(['repo.ts|Row.state']);
  });

  test('an entry does not suppress a finding of another verdict', () => {
    const { allowed, real, stale } = applyAllowlist([finding('too-wide')], entry);
    expect(allowed).toEqual([]);
    expect(real).toHaveLength(1);
    expect(stale).toEqual(['repo.ts|Row.state']);
  });

  test('an entry does not survive a change of the wire type, so the finding surfaces', () => {
    const { allowed, real, stale } = applyAllowlist([finding('unsound', { wire: 'number' })], entry);
    expect(allowed).toEqual([]);
    expect(real).toHaveLength(1);
    expect(stale).toEqual(['repo.ts|Row.state']);
  });

  test('an entry does not survive a change of the declared type', () => {
    const { allowed, real } = applyAllowlist([finding('unsound', { declared: 'string | number' })], entry);
    expect(allowed).toEqual([]);
    expect(real).toHaveLength(1);
  });
});

/** Stands in for pg's Pool: records the statements and answers with the given rows. */
function poolStub(respond: (text: string) => unknown): { pool: Pool; texts: string[]; values: unknown[][] } {
  const texts: string[] = [];
  const values: unknown[][] = [];
  const pool = {
    query: (arg: unknown, params?: unknown[]) => {
      const text = typeof arg === 'string' ? arg : (arg as { text: string }).text;
      const bound = typeof arg === 'string' ? params : (arg as { values?: unknown[] }).values;
      texts.push(text);
      values.push(bound ?? []);
      return Promise.resolve(respond(text));
    },
  } as unknown as Pool;
  return { pool, texts, values };
}

describe('probeSelect', () => {
  test('wraps the statement in a LIMIT 0 subquery with the parameters nulled out', async () => {
    const { pool, texts, values } = poolStub(() => ({ fields: [{ name: 'id', dataTypeID: 23, tableID: 100, columnID: 1 }, { name: 'host', dataTypeID: 25, tableID: 0, columnID: 0 }] }));
    const result = await probeSelect(pool, 'SELECT id, host FROM deploy_history WHERE host = $1 AND stack = $2');
    expect(texts[0]).toContain('AS __row_wire_probe LIMIT 0');
    expect(texts[0]).toContain('SELECT id, host FROM deploy_history');
    expect(values[0]).toEqual([null, null]);
    expect(result.columns).toEqual([
      { name: 'id', pgType: '23', tableID: 100, columnID: 1 },
      { name: 'host', pgType: '25', tableID: 0, columnID: 0 },
    ]);
  });

  test('returns the driver error instead of throwing', async () => {
    const { pool } = poolStub(() => {
      throw new Error('operator does not exist: text = timestamp with time zone');
    });
    expect(await probeSelect(pool, 'SELECT 1 FROM t WHERE time > $1')).toEqual({
      error: 'operator does not exist: text = timestamp with time zone',
    });
  });
});

describe('probeDml', () => {
  test('describes the statement instead of running it, and reports the result oids', async () => {
    const { pool, texts, values } = poolStub((text) =>
      text.includes('pg_prepared_statements') ? { rows: [{ oids: [23, 25] }] } : {},
    );
    const result = await probeDml(pool, 'UPDATE deploy_history SET status = $1 WHERE id = $2 RETURNING id, host');
    expect(texts[0]).toBe('DEALLOCATE ALL');
    expect(texts[1]).toContain('PREPARE __row_wire_probe AS UPDATE deploy_history');
    expect(texts[2]).toContain('pg_prepared_statements');
    expect(values[2]).toEqual(['__row_wire_probe']);
    expect(texts.at(-1)).toBe('DEALLOCATE ALL');
    expect(result.typeOids).toEqual(['23', '25']);
  });

  test('reports a statement Postgres described no result types for', async () => {
    const { pool } = poolStub((text) => (text.includes('pg_prepared_statements') ? { rows: [] } : {}));
    expect(await probeDml(pool, 'UPDATE t SET a = $1 RETURNING a')).toEqual({
      error: 'PREPARE left no row in pg_prepared_statements',
    });
  });

  test('returns a prepare failure instead of throwing', async () => {
    const { pool } = poolStub((text) => {
      if (text.startsWith('PREPARE')) throw new Error('could not determine data type of parameter $4');
      return {};
    });
    const result = await probeDml(pool, 'SELECT * FROM t WHERE a = $4');
    expect(result.error).toBe('could not determine data type of parameter $4');
  });
});

/** PostgreSQL's own OIDs for the types the table maps, so the driver can be asked without a database. */
const PG_TYPE_OIDS: Record<string, number> = {
  bool: 16, bytea: 17, name: 19, int8: 20, int2: 21, int4: 23, text: 25, oid: 26, json: 114,
  cidr: 650, float4: 700, float8: 701, money: 790, inet: 869, bpchar: 1042, varchar: 1043,
  date: 1082, timestamp: 1114, timestamptz: 1184, interval: 1186, numeric: 1700, uuid: 2950, jsonb: 3802,
  _bool: 1000, _int2: 1005, _int4: 1007, _text: 1009, _varchar: 1015, _int8: 1016,
  _float4: 1021, _float8: 1022, _numeric: 1231, _timestamp: 1115, _date: 1182,
  _timestamptz: 1185, _json: 199, _jsonb: 3807,
};

describe('assertWireTypeTable against real pg type oids', () => {
  test('every entry matches what the driver parses for that oid', () => {
    expect(assertWireTypeTable(new Map(Object.entries(PG_TYPE_OIDS)))).toEqual([]);
  });

  test('an entry pointed at the wrong parser is reported with both sides', () => {
    const swapped = new Map(Object.entries({ ...PG_TYPE_OIDS, int4: 20 }));
    expect(assertWireTypeTable(swapped)).toEqual(['int4: table says number (number), driver parsed string']);
  });

  test('the fixed oids cover every mapped type, so none is silently unchecked', () => {
    expect(Object.keys(PG_TYPE_OIDS).sort()).toEqual(Object.keys(WIRE_TYPE_BY_PG_TYPE).sort());
  });
});

describe('scrapeFile row shapes', () => {
  test('reads a row type declared as a type alias', () => {
    const file = fixture('alias.ts', 'type ValueRow = { value: string };\nconst q = pool.query<ValueRow>(`SELECT value FROM entity_metadata`);');
    const [site] = scrapeFile(file, fixtureDir);
    expect(site.rowFields).toEqual([{ name: 'value', type: 'string', optional: false }]);
  });

  test('reads an inline type argument', () => {
    const file = fixture('inline.ts', 'const q = pool.query<{ ready: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ready`);');
    const [site] = scrapeFile(file, fixtureDir);
    expect(site.rowFields).toEqual([{ name: 'ready', type: 'boolean', optional: false }]);
  });
});

describe('observe: one row type fed by several statements', () => {
  const key = 'src/lib/database/repositories/proxmox-stats-repository.ts|ProxmoxStatsQueryRow';
  const site = (rowFields: QuerySite['rowFields'] = null): QuerySite => ({
    file: 'src/lib/database/repositories/proxmox-stats-repository.ts',
    line: 12,
    rowType: 'ProxmoxStatsQueryRow',
    rowFields,
    sql: 'SELECT host, mem FROM proxmox_stats',
    dynamic: [],
  });
  const columns = [
    { name: 'host', wire: 'string', nullable: false as const },
    { name: 'mem', wire: 'number', nullable: false as const },
  ];

  test('counts a field once per statement that returns it', () => {
    const observations = new Map<string, ObservedRowType>();
    observe(observations, site(), columns);
    observe(observations, site(), columns);
    expect(observations.get(key)?.fields.get('host')?.seen).toBe(2);
    expect(observations.get(key)?.fields.get('host')?.wire).toEqual(new Set(['string']));
  });

  test('keeps the first resolved row shape and fills one the first site could not resolve', () => {
    const observations = new Map<string, ObservedRowType>();
    const first = [{ name: 'host', type: 'string', optional: false }];
    const second = [{ name: 'host', type: 'number', optional: false }];
    observe(observations, site(first), [columns[0]]);
    observe(observations, site(second), [columns[0]]);
    expect(observations.get(key)?.rowFields).toEqual(first);

    const late = new Map<string, ObservedRowType>();
    observe(late, site(null), [columns[0]]);
    observe(late, site(second), [columns[0]]);
    expect(late.get(key)?.rowFields).toEqual(second);
  });

  test('calls a column mixed only when two statements truly disagree about nullability', () => {
    const observations = new Map<string, ObservedRowType>();
    observe(observations, site(), columns);
    observe(observations, site(), [{ name: 'host', wire: 'string', nullable: false }, { name: 'mem', wire: 'number', nullable: true }]);
    expect(observations.get(key)?.fields.get('mem')?.nullable).toBe('mixed');
    expect(observations.get(key)?.fields.get('host')?.nullable).toBe(false);
  });

  test('an unknown nullability from a view does not hide what a base table proved', () => {
    const observations = new Map<string, ObservedRowType>();
    observe(observations, site(), [{ name: 'host', wire: 'string', nullable: false }]);
    observe(observations, site(), [{ name: 'host', wire: 'string', nullable: '?' }]);
    expect(observations.get(key)?.fields.get('host')?.nullable).toBe(false);
  });

  test('a declared non-null type fails when the row type\'s statements disagree on nullability', () => {
    const observed: ObservedField = { wire: new Set(['string']), nullable: 'mixed', seen: 2 };
    const verdicts = (type: string) => compareField({ file: 'f.ts', line: 1, rowType: 'Row' }, { name: 'host', type, optional: false }, observed, true).map((finding) => finding.verdict);
    expect(verdicts('string')).toEqual(['unsound']);
    expect(verdicts('string | null')).toEqual([]);
  });

  test('leaves nullability unknown when no statement can answer', () => {
    const observations = new Map<string, ObservedRowType>();
    observe(observations, site(), [{ name: 'host', wire: 'string', nullable: '?' }]);
    expect(observations.get(key)?.fields.get('host')?.nullable).toBe('?');
  });
});

describe('nullability from result metadata', () => {
  const attributes: Record<string, { oid: number; kind: string; notNull: Record<number, boolean> }> = {
    managed_hosts: { oid: 10, kind: 'r', notNull: { 1: true, 2: false } },
    entity_metadata: { oid: 20, kind: 'r', notNull: { 1: true } },
    proxmox_stats_1m: { oid: 30, kind: 'v', notNull: { 1: false } },
  };
  const catalog: AttributeCatalog = {
    relation: (oid) => Object.entries(attributes).map(([name, value]) => ({ name, ...value })).find((relation) => relation.oid === oid),
    attributeNotNull: (oid, attnum) => Object.values(attributes).find((relation) => relation.oid === oid)?.notNull[attnum],
    columnsOf: (table) => Object.keys(attributes[table]?.notNull ?? {}),
    columnNotNull: (table, column) => (table === 'managed_hosts' ? { id: true, agent_version: false }[column] : undefined),
  };

  test('a NOT NULL column of an ordinary table is not nullable and a nullable one is', () => {
    expect(selectNullability({ tableID: 10, columnID: 1 }, 'SELECT id FROM managed_hosts', catalog)).toBe(false);
    expect(selectNullability({ tableID: 10, columnID: 2 }, 'SELECT agent_version FROM managed_hosts', catalog)).toBe(true);
  });

  test('a computed column is unknown, so an aggregate aliased to a NOT NULL column is not taken as NOT NULL', () => {
    expect(selectNullability({ tableID: 0, columnID: 0 }, 'SELECT max(id) AS id FROM managed_hosts', catalog)).toBe('?');
  });

  test('a view or aggregate column is unknown because views report every column nullable', () => {
    expect(selectNullability({ tableID: 30, columnID: 1 }, 'SELECT host FROM proxmox_stats_1m', catalog)).toBe('?');
  });

  test('the right side of a LEFT JOIN is nullable even when the column is NOT NULL, while the left side keeps its answer', () => {
    const sql = 'SELECT me.value, h.id FROM entity_metadata me LEFT JOIN managed_hosts h ON h.name = me.entity';
    expect(selectNullability({ tableID: 20, columnID: 1 }, sql, catalog)).toBe(false);
    expect(selectNullability({ tableID: 10, columnID: 1 }, sql, catalog)).toBe(true);
  });

  test('a table joined on both sides of the statement cannot be attributed, so it is unknown', () => {
    const sql = 'SELECT a.value FROM entity_metadata a LEFT JOIN entity_metadata b ON b.entity = a.entity';
    expect(selectNullability({ tableID: 20, columnID: 1 }, sql, catalog)).toBe('?');
  });

  test('a LEFT JOIN to a name that is not a table (a CTE) makes every column unknown', () => {
    const sql = 'WITH x AS (SELECT 1 AS n) SELECT h.id FROM managed_hosts h LEFT JOIN x ON true';
    expect(selectNullability({ tableID: 10, columnID: 1 }, sql, catalog)).toBe('?');
  });

  test('a RIGHT or FULL join makes every column unknown', () => {
    expect(outerJoinedTables('SELECT 1 FROM a FULL OUTER JOIN b ON true').everything).toBe(true);
    expect(selectNullability({ tableID: 20, columnID: 1 }, 'SELECT me.value FROM entity_metadata me RIGHT JOIN managed_hosts h ON true', catalog)).toBe('?');
  });

  test.each([
    ['a subquery', 'SELECT h.id FROM entity_metadata me LEFT JOIN (SELECT id FROM managed_hosts) h ON true'],
    ['LATERAL', 'SELECT h.id FROM entity_metadata me LEFT JOIN LATERAL (SELECT id FROM managed_hosts) h ON true'],
    ['a schema-qualified name', 'SELECT h.id FROM entity_metadata me LEFT JOIN public.managed_hosts h ON true'],
    ['a quoted name', 'SELECT h.id FROM entity_metadata me LEFT JOIN "managed_hosts" h ON true'],
    ['a lowercase outer keyword', 'select h.id from entity_metadata me left outer join (select 1) h on true'],
  ])('a LEFT JOIN to %s is not trusted to a base column attnotnull', (_label, sql) => {
    expect(outerJoinedTables(sql).everything).toBe(true);
    expect(selectNullability({ tableID: 10, columnID: 1 }, sql, catalog)).toBe('?');
    expect(selectNullability({ tableID: 20, columnID: 1 }, sql, catalog)).toBe('?');
  });

  test('a plain LEFT JOIN with an alias or an outer keyword is attributed to its table', () => {
    expect(outerJoinedTables('SELECT 1 FROM a LEFT OUTER JOIN Managed_Hosts AS h ON true')).toEqual({ everything: false, tables: new Set(['managed_hosts']) });
  });

  test('only a bare column of the target table answers for a RETURNING item', () => {
    expect(returningNullability({ name: 'id', plain: true }, 'managed_hosts', catalog)).toBe(false);
    expect(returningNullability({ name: 'agent_version', plain: true }, 'managed_hosts', catalog)).toBe(true);
    expect(returningNullability({ name: 'id', plain: false }, 'managed_hosts', catalog)).toBe('?');
    expect(returningNullability({ name: 'id', plain: true }, undefined, catalog)).toBe('?');
  });

  test('marks which RETURNING items are bare columns', () => {
    expect(returningItems('UPDATE t SET a = 1 RETURNING id, count(*) AS total, t.name', () => [])).toEqual([
      { name: 'id', plain: true },
      { name: 'total', plain: false },
      { name: 'name', plain: true },
    ]);
  });
});

describe('untyped reads', () => {
  const reads = (source: string): number[] => scrapeUntypedReads(fixture(`untyped-${Math.random()}.ts`, source), fixtureDir).map((read) => read.line);

  test('flags an untyped query whose rows are read', () => {
    expect(reads('async function f(pool) {\n  const result = await pool.query(`SELECT 1`);\n  return result.rows[0];\n}')).toEqual([2]);
    expect(reads('async function f(pool) {\n  const { rows } = await pool.query(`SELECT 1`);\n  return rows;\n}')).toEqual([2]);
    expect(reads('async function f(pool) {\n  return (await pool.query(`SELECT 1`)).rows;\n}')).toEqual([2]);
    expect(reads('function f(pool) {\n  return pool.query(`SELECT 1`);\n}')).toEqual([2]);
  });

  test('flags every shape that lets the rows leave the call', () => {
    const flagged = (body: string): number[] => reads(`async function f(pool, client) {\n${body}\n}`);
    expect(flagged('  return await pool.query(`SELECT 1`);')).toEqual([2]);
    expect(flagged('  const res = await pool.query(`SELECT 1`);\n  return res;')).toEqual([2]);
    expect(flagged('  const res = await pool.query(`SELECT 1`);\n  const { rows } = res;\n  return rows;')).toEqual([2]);
    expect(flagged('  const res = await pool.query(`SELECT 1`);\n  log(res.rows.length);')).toEqual([2]);
    expect(flagged('  const [a, b] = await Promise.all([\n    pool.query(`SELECT 1`),\n    pool.query(`SELECT 2`),\n  ]);\n  return [a.rows, b.rows];')).toEqual([3, 4]);
    expect(flagged('  const [{ rows }] = await Promise.all([pool.query(`SELECT 1`)]);\n  return rows;')).toEqual([2]);
    expect(flagged('  const results = await Promise.all([pool.query(`SELECT 1`)]);\n  return results;')).toEqual([2]);
    expect(flagged('  return pool.query(`SELECT 1`).then((r) => r.rows);')).toEqual([2]);
    expect(flagged('  const rows = await pool.query(`SELECT 1`).catch(() => null);\n  return rows;')).toEqual([2]);
    expect(flagged('  let res;\n  res = await pool.query(`SELECT 1`);\n  return res;')).toEqual([3]);
    expect(flagged('  consume(await pool.query(`SELECT 1`));')).toEqual([2]);
  });

  test('flags an arrow function that returns the result implicitly', () => {
    expect(reads('const run = (pool) => pool.query(`SELECT 1`);')).toEqual([1]);
    expect(reads('const run = async (pool) => (await pool.query(`SELECT 1`)).rows;')).toEqual([1]);
  });

  test('leaves every discarded or rowless use of the result alone', () => {
    const flagged = (body: string): number[] => reads(`async function f(pool, client) {\n${body}\n}`);
    expect(flagged('  await client.query(`BEGIN`);')).toEqual([]);
    expect(flagged('  await pool.query(`SELECT 1`).catch(() => undefined);')).toEqual([]);
    expect(flagged('  void pool.query(`NOTIFY x`);')).toEqual([]);
    expect(flagged('  await Promise.all([pool.query(`SELECT 1`), pool.query(`SELECT 2`)]);')).toEqual([]);
    expect(flagged('  const res = await pool.query(`DELETE FROM t`);\n  log(res.rowCount, res.command);')).toEqual([]);
    expect(flagged('  const { rowCount } = await pool.query(`DELETE FROM t`);\n  return rowCount;')).toEqual([]);
    expect(flagged('  const [a, b] = await Promise.all([pool.query(`DELETE FROM t`), pool.query(`DELETE FROM u`)]);\n  return a.rowCount + b.rowCount;')).toEqual([]);
  });

  test('a reused variable name elsewhere in the function is not a read of the untyped result', () => {
    const flagged = (body: string): number[] => reads(`async function f(pool, items) {\n${body}\n}`);
    expect(flagged('  if (items) {\n    const res = await pool.query(`DELETE FROM t`);\n    log(res.rowCount);\n  }\n  const res = items.map((x) => x);\n  return res;')).toEqual([]);
    expect(flagged('  const res = await pool.query(`DELETE FROM t`);\n  items.forEach((res) => log(res));\n  return res.rowCount;')).toEqual([]);
    expect(flagged('  {\n    const res = await pool.query(`DELETE FROM t`);\n    log(res.rowCount);\n  }\n  {\n    const res = await other();\n    return res.rows;\n  }')).toEqual([]);
    expect(flagged('  const res = await pool.query(`DELETE FROM t`);\n  return items.res;')).toEqual([]);
  });

  test('leaves a discarded result, a row count and a typed query alone', () => {
    expect(reads('async function f(pool) {\n  await pool.query(`LISTEN x`);\n}')).toEqual([]);
    expect(reads('async function f(pool) {\n  const result = await pool.query(`DELETE FROM t`);\n  return result.rowCount;\n}')).toEqual([]);
    expect(reads('async function f(pool) {\n  const result = await pool.query<{ id: number }>(`SELECT 1`);\n  return result.rows;\n}')).toEqual([]);
  });

  test('collectUntypedReads walks several directories and skips tests', () => {
    const dir = fs.mkdtempSync(path.join(fixtureDir, 'untyped-tree-'));
    fs.mkdirSync(path.join(dir, '__tests__'));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'const r = (await pool.query(`SELECT 1`)).rows;');
    fs.writeFileSync(path.join(dir, '__tests__', 'b.ts'), 'const r = (await pool.query(`SELECT 1`)).rows;');
    expect(collectUntypedReads([dir, path.join(dir, 'missing')], fixtureDir)).toHaveLength(1);
  });
});

describe('scrapeFile declarations', () => {
  test('refuses a row type declared twice in one file instead of merging them', () => {
    const file = fixture('twice.ts', [
      'function a() { interface Row { id: number } return pool.query<Row>(`SELECT id FROM t`); }',
      'function b() { interface Row { name: string } return pool.query<Row>(`SELECT name FROM t`); }',
    ].join('\n'));
    expect(scrapeFile(file, fixtureDir).map((site) => site.rowFields)).toEqual([null, null]);
  });

  test('refuses a row type that extends a base it cannot see', () => {
    const file = fixture('imported-base.ts', 'import type { Base } from "./base";\ninterface Row extends Base { id: number }\nconst q = pool.query<Row>(`SELECT id FROM t`);');
    expect(scrapeFile(file, fixtureDir)[0].rowFields).toBeNull();
  });

  test('follows a base declared in the same file', () => {
    const file = fixture('local-base.ts', 'interface Base { id: number }\ninterface Row extends Base { name: string }\nconst q = pool.query<Row>(`SELECT id, name FROM t`);');
    expect(scrapeFile(file, fixtureDir)[0].rowFields?.map((field) => field.name)).toEqual(['name', 'id']);
  });
});

describe('checkSites and evaluate', () => {
  const columnsOf = (table: string): string[] => (table === 't' ? ['id', 'name'] : []);
  const catalog: AttributeCatalog = {
    relation: (oid) => (oid === 1 ? { name: 't', kind: 'r' } : undefined),
    attributeNotNull: (_oid, attnum) => attnum === 1,
    columnsOf,
    columnNotNull: (table, column) => (table === 't' ? column === 'id' : undefined),
  };
  const pgTypeByOid = new Map([['23', 'int4'], ['25', 'text'], ['3614', 'tsvector']]);
  const site = (overrides: Partial<QuerySite> = {}): QuerySite => ({
    file: 'repo.ts',
    line: 3,
    rowType: 'Row',
    rowFields: [{ name: 'id', type: 'number', optional: false }, { name: 'name', type: 'string | null', optional: false }],
    sql: 'SELECT id, name FROM t',
    dynamic: [],
    ...overrides,
  });
  const selectPool = poolStub(() => ({
    fields: [{ name: 'id', dataTypeID: 23, tableID: 1, columnID: 1 }, { name: 'name', dataTypeID: 25, tableID: 1, columnID: 2 }],
  })).pool;
  const scan = { sites: 1, untypedReads: [], minSites: 1 };

  test('a matching row type passes with exit code zero', async () => {
    const result = await checkSites([site()], { pool: selectPool, pgTypeByOid, catalog });
    expect(result.problems).toEqual([]);
    expect(result.probed).toBe(1);
    expect(evaluate(result, scan, {}).failed).toBe(false);
  });

  test('a mismatching field fails', async () => {
    const result = await checkSites([site({ rowFields: [{ name: 'id', type: 'string', optional: false }, { name: 'name', type: 'string | null', optional: false }] })], { pool: selectPool, pgTypeByOid, catalog });
    const evaluation = evaluate(result, scan, {});
    expect(evaluation.failed).toBe(true);
    expect(evaluation.real.map((finding) => `${finding.field}:${finding.verdict}`)).toEqual(['id:unsound']);
  });

  test('a stale allowlist entry fails even when every field matches', async () => {
    const result = await checkSites([site()], { pool: selectPool, pgTypeByOid, catalog });
    const evaluation = evaluate(result, scan, { 'repo.ts|Row.name': { reason: 'r', declared: 'string', wire: 'string' } });
    expect(evaluation.failed).toBe(true);
    expect(evaluation.stale).toEqual(['repo.ts|Row.name']);
  });

  test('evaluate with a row type filter does not call the other types\' allowlist entries stale', async () => {
    const result = await checkSites([site()], { pool: selectPool, pgTypeByOid, catalog });
    const evaluation = evaluate(result, scan, { 'other.ts|Other.name': { reason: 'r', declared: 'string', wire: 'string' } }, 'Row');
    expect(evaluation.failed).toBe(false);
    expect(evaluation.stale).toEqual([]);
  });

  test('a non-null declaration on a column from the nullable side of a LEFT JOIN fails', async () => {
    const joined = [{ name: 'id', type: 'number', optional: false }, { name: 'name', type: 'string', optional: false }];
    const leftJoin = site({ rowFields: joined, sql: 'SELECT a.id, b.name FROM t a LEFT JOIN u b ON true' });
    const stub = poolStub(() => ({
      fields: [{ name: 'id', dataTypeID: 23, tableID: 1, columnID: 1 }, { name: 'name', dataTypeID: 25, tableID: 2, columnID: 1 }],
    })).pool;
    const joinCatalog: AttributeCatalog = {
      relation: (oid) => ({ name: oid === 1 ? 't' : 'u', kind: 'r' }),
      attributeNotNull: () => true,
      columnsOf: (table) => (table === 't' || table === 'u' ? ['id', 'name'] : []),
      columnNotNull: () => true,
    };
    const result = await checkSites([leftJoin], { pool: stub, pgTypeByOid, catalog: joinCatalog });
    const evaluation = evaluate(result, scan, {});
    expect(evaluation.real.map((finding) => `${finding.field}:${finding.verdict}`)).toEqual(['name:unsound']);
  });

  test('a scan below the recorded floor fails', async () => {
    const result = await checkSites([site()], { pool: selectPool, pgTypeByOid, catalog });
    const evaluation = evaluate(result, { ...scan, minSites: 5 }, {});
    expect(evaluation.failed).toBe(true);
    expect(evaluation.problems[0]).toContain('fewer than the 5 recorded');
  });

  test('an untyped read fails', async () => {
    const result = await checkSites([site()], { pool: selectPool, pgTypeByOid, catalog });
    const evaluation = evaluate(result, { ...scan, untypedReads: [{ file: 'repo.ts', line: 9 }] }, {});
    expect(evaluation.failed).toBe(true);
    expect(evaluation.problems[0]).toContain('repo.ts:9');
  });

  test('a statement it cannot read, a row type it cannot resolve and an unmapped pg type are problems, not skips', async () => {
    const unmapped = poolStub(() => ({ fields: [{ name: 'doc', dataTypeID: 3614, tableID: 0, columnID: 0 }] })).pool;
    const result = await checkSites(
      [
        site({ sql: null }),
        site({ rowFields: null, line: 4 }),
        site({ line: 5, rowFields: [{ name: 'doc', type: 'string', optional: false }] }),
        site({ line: 6, sql: 'EXPLAIN SELECT 1' }),
      ],
      { pool: unmapped, pgTypeByOid, catalog },
    );
    expect(result.problems).toHaveLength(4);
    expect(result.problems.join('\n')).toContain('tsvector');
  });

  test('an unmapped pg type on a RETURNING statement is a problem like on a SELECT', async () => {
    const dml = poolStub((text) => (text.includes('pg_prepared_statements') ? { rows: [{ oids: [3614] }] } : {})).pool;
    const result = await checkSites(
      [site({ sql: 'UPDATE t SET a = 1 RETURNING doc', rowFields: [{ name: 'doc', type: 'string', optional: false }] })],
      { pool: dml, pgTypeByOid, catalog },
    );
    expect(result.problems.join('\n')).toContain('tsvector');
  });

  test('a nullable column declared without null is unsound only when the table proves it', async () => {
    const result = await checkSites([site({ rowFields: [{ name: 'id', type: 'number', optional: false }, { name: 'name', type: 'string', optional: false }] })], { pool: selectPool, pgTypeByOid, catalog });
    expect(evaluate(result, scan, {}).real.map((finding) => finding.field)).toEqual(['name']);
  });
});

describe('site count floor', () => {
  const repoRoot = path.join(import.meta.dir, '..', '..');

  test('MIN_QUERY_SITES equals the typed query sites in src and server, so changing it is a visible edit', () => {
    // Adding a query<Row> site raises this number and removing one lowers it. A lowered floor hides statements from the scan.
    expect(collectSites([path.join(repoRoot, 'src'), path.join(repoRoot, 'server')], repoRoot)).toHaveLength(MIN_QUERY_SITES);
  });

  test('no untyped query in src or server lets its rows leave the call', () => {
    expect(collectUntypedReads([path.join(repoRoot, 'src'), path.join(repoRoot, 'server')], repoRoot)).toEqual([]);
  });
});
