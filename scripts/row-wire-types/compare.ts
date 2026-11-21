import type { RowField } from './scrape';

/** Narrowings the schema enforces and the wire cannot express, keyed `<file>|<RowType>.<field>`. An entry that stops matching a finding fails the check. */
export const ALLOWED_NARROWINGS: Record<string, string> = {
  'src/lib/database/repositories/docker-container-event-repository.ts|ContainerEventQueryRow.state':
    'docker_container_events_fields_match_type CHECK: an upsert row always carries state, a destroy row always has NULL, and state is only read on the upsert branch',
  'src/lib/database/repositories/docker-container-event-repository.ts|ContainerEventQueryRow.name':
    'docker_container_events_fields_match_type CHECK: an upsert row always carries name, a destroy row always has NULL, and name is only read on the upsert branch',
  'src/lib/database/repositories/docker-container-event-repository.ts|ContainerEventQueryRow.image':
    'docker_container_events_fields_match_type CHECK: an upsert row always carries image, a destroy row always has NULL, and image is only read on the upsert branch',
};

const PRIMITIVE_WIRE_TYPES = new Set(['number', 'string', 'boolean', 'Date', 'Buffer', 'PostgresInterval']);

export interface DeclaredType {
  nullable: boolean;
  atoms: string[];
}

export function parseDeclaredType(declared: string): DeclaredType {
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

export type Verdict = 'unsound' | 'too-wide' | 'undeclared' | 'never-returned';

export interface Finding {
  verdict: Verdict;
  file: string;
  line: number;
  rowType: string;
  field: string;
  declared?: string;
  wire?: string;
  detail: string;
}

export interface ObservedField {
  wire: Set<string>;
  nullable: boolean | '?' | 'mixed';
  seen: number;
}

export interface FieldContext {
  file: string;
  line: number;
  rowType: string;
}

export function compareField(
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

export interface ObservedRowType {
  rowType: string;
  file: string;
  line: number;
  rowFields: RowField[] | null;
  fields: Map<string, ObservedField>;
  projections: Map<string, boolean>[];
}

/** Field-by-field comparison of every observed row type, skipping any type the caller filtered out. */
export function compareObservations(
  observations: Map<string, ObservedRowType>,
  onlyType?: string,
): { findings: Finding[]; problems: string[] } {
  const findings: Finding[] = [];
  const problems: string[] = [];
  for (const [key, observed] of [...observations].sort()) {
    if (onlyType && observed.rowType !== onlyType) continue;
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
  return { findings, problems };
}

export function allowlistKey(finding: Pick<Finding, 'file' | 'rowType' | 'field'>): string {
  return `${finding.file}|${finding.rowType}.${finding.field}`;
}

export function applyAllowlist(
  findings: Finding[],
  allowlist: Record<string, string>,
): { allowed: { finding: Finding; reason: string }[]; real: Finding[]; stale: string[] } {
  const allowed: { finding: Finding; reason: string }[] = [];
  const real: Finding[] = [];
  const used = new Set<string>();
  for (const finding of findings) {
    const key = allowlistKey(finding);
    const reason = allowlist[key];
    if (reason && finding.verdict === 'unsound') {
      allowed.push({ finding, reason });
      used.add(key);
    } else {
      real.push(finding);
    }
  }
  return { allowed, real, stale: Object.keys(allowlist).filter((key) => !used.has(key)) };
}
