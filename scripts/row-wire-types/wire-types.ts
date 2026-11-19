import pg from 'pg';

/** The JS type node-postgres hands back, keyed by the pg type name. */
export const WIRE_TYPE_BY_PG_TYPE: Readonly<Record<string, string | undefined>> = {
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

export const SAMPLE_BY_PG_TYPE: Readonly<Record<string, string | undefined>> = {
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
export const RUNTIME_SHAPE_BY_WIRE_TYPE: Readonly<Record<string, string[] | undefined>> = {
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

export type TypeParser = (value: string) => unknown;

/** The pool's own parser instance, so a setTypeParser override is respected. */
export const parserFor = (oid: number): TypeParser => pg.types.getTypeParser(oid, 'text') as TypeParser;

export function runtimeTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Date) return 'Date';
  if (Array.isArray(value)) return value.every((entry) => entry instanceof Date) ? 'Date[]' : 'array';
  return typeof value;
}

/** Fails when the driver stops parsing a type the way the table above claims. */
export function assertWireTypeTable(oidByPgTypeName: Map<string, number>): string[] {
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
