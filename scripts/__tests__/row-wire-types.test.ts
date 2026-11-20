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
import { collectSites, scrapeFile, type QuerySite } from '../row-wire-types/scrape';
import { observe, type Catalog } from '../row-wire-types/observe';
import {
  isReturningDmlStatement,
  isSelectStatement,
  probeDml,
  probeSelect,
  resolveDynamicSql,
  returningNames,
  tierRelationsFor,
} from '../row-wire-types/probe';
import {
  applyAllowlist,
  compareField,
  compareObservations,
  parseDeclaredType,
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
  const finding = (verdict: Finding['verdict']): Finding => ({
    verdict,
    file: 'repo.ts',
    line: 1,
    rowType: 'Row',
    field: 'state',
    declared: 'string',
    wire: 'string',
    detail: 'the column is nullable and the declared type has no null',
  });
  const entry = { 'repo.ts|Row.state': 'CHECK keeps it set on the branch that reads it' };

  test('suppresses an unsound finding the entry names', () => {
    const { allowed, real, stale } = applyAllowlist([finding('unsound')], entry);
    expect(allowed).toHaveLength(1);
    expect(allowed[0].reason).toBe('CHECK keeps it set on the branch that reads it');
    expect(real).toEqual([]);
    expect(stale).toEqual([]);
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
    const { pool, texts, values } = poolStub(() => ({ fields: [{ name: 'id', dataTypeID: 23 }, { name: 'host', dataTypeID: 25 }] }));
    const result = await probeSelect(pool, 'SELECT id, host FROM deploy_history WHERE host = $1 AND stack = $2');
    expect(texts[0]).toContain('AS __row_wire_probe LIMIT 0');
    expect(texts[0]).toContain('SELECT id, host FROM deploy_history');
    expect(values[0]).toEqual([null, null]);
    expect(result.columns).toEqual([{ name: 'id', pgType: '23' }, { name: 'host', pgType: '25' }]);
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
  const catalog: Catalog = {
    columnsOf: () => [],
    tablesIn: () => ['proxmox_stats'],
    nullability: () => false,
  };
  const site = (sql: string): QuerySite => ({
    file: 'src/lib/database/repositories/proxmox-stats-repository.ts',
    line: 12,
    rowType: 'ProxmoxStatsQueryRow',
    rowFields: null,
    sql,
    dynamic: [],
  });
  const columns = [
    { name: 'host', wire: 'string' },
    { name: 'mem', wire: 'number' },
  ];

  test('counts a field once per statement that returns it', () => {
    const observations = new Map<string, ObservedRowType>();
    observe(observations, site('SELECT host, mem FROM proxmox_stats'), columns, 'SELECT host, mem FROM proxmox_stats', catalog);
    observe(observations, site('SELECT host, mem FROM proxmox_stats_1h_avg'), columns, 'SELECT host, mem FROM proxmox_stats_1h_avg', catalog);
    const observed = observations.get('src/lib/database/repositories/proxmox-stats-repository.ts|ProxmoxStatsQueryRow');
    expect(observed?.fields.get('host')?.seen).toBe(2);
    expect(observed?.fields.get('host')?.wire).toEqual(new Set(['string']));
  });

  test('records the projections separately, and keeps the first row shape', () => {
    const observations = new Map<string, ObservedRowType>();
    const rowFields = [{ name: 'host', type: 'string', optional: false }];
    observe(observations, { ...site('SELECT host FROM proxmox_stats'), rowFields }, [columns[0]], 'SELECT host FROM proxmox_stats', catalog);
    expect(observations.size).toBe(1);
    const observed = observations.get('src/lib/database/repositories/proxmox-stats-repository.ts|ProxmoxStatsQueryRow');
    expect(observed?.rowFields).toEqual(rowFields);
    expect(observed?.projections).toEqual([]);
  });

  test('calls a column mixed when the tiers disagree about nullability', () => {
    const observations = new Map<string, ObservedRowType>();
    const perTier: Catalog = { ...catalog, nullability: (column) => (column === 'mem' ? true : false) };
    observe(observations, site('SELECT host, mem FROM proxmox_stats'), columns, 'SELECT host, mem FROM proxmox_stats', catalog);
    observe(observations, site('SELECT host, mem FROM proxmox_stats_1h_avg'), columns, 'SELECT host, mem FROM proxmox_stats_1h_avg', perTier);
    const observed = observations.get('src/lib/database/repositories/proxmox-stats-repository.ts|ProxmoxStatsQueryRow');
    expect(observed?.fields.get('mem')?.nullable).toBe('mixed');
    expect(observed?.fields.get('host')?.nullable).toBe(false);
  });

  test('leaves nullability unknown when the catalog cannot answer', () => {
    const unknown: Catalog = { ...catalog, nullability: () => '?' };
    const observations = new Map<string, ObservedRowType>();
    observe(observations, site('SELECT host FROM proxmox_stats'), [columns[0]], 'SELECT host FROM proxmox_stats', unknown);
    const observed = observations.get('src/lib/database/repositories/proxmox-stats-repository.ts|ProxmoxStatsQueryRow');
    expect(observed?.fields.get('host')?.nullable).toBe('?');
  });
});
