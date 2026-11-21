import type { Pool } from 'pg';
import type { QuerySite, UntypedRead } from './scrape';
import {
  isReturningDmlStatement,
  isSelectStatement,
  probeDml,
  probeSelect,
  resolveDynamicSql,
  returningItems,
  returningTable,
  tierRelationsFor,
} from './probe';
import {
  applyAllowlist,
  compareObservations,
  type AllowedNarrowing,
  type Finding,
  type ObservedRowType,
} from './compare';
import { observe } from './observe';
import { returningNullability, selectNullability, type AttributeCatalog, type Nullability } from './nullability';
import { WIRE_TYPE_BY_PG_TYPE } from './wire-types';

export interface CheckEnv {
  pool: Pool;
  pgTypeByOid: Map<string, string>;
  catalog: AttributeCatalog;
}

export interface CheckResult {
  observations: Map<string, ObservedRowType>;
  problems: string[];
  probed: number;
}

interface WireColumn {
  name: string;
  wire: string;
  nullable: Nullability;
}

export async function checkSites(sites: QuerySite[], env: CheckEnv): Promise<CheckResult> {
  const { pool, pgTypeByOid, catalog } = env;
  const problems: string[] = [];
  const observations = new Map<string, ObservedRowType>();
  let probed = 0;
  const wireOf = (oid: string): string | undefined => WIRE_TYPE_BY_PG_TYPE[pgTypeByOid.get(oid) ?? ''];

  for (const site of sites) {
    const label = `${site.file}:${site.line} [${site.rowType}]`;
    if (site.sql === null) {
      problems.push(`${label} cannot be probed: the statement is not a string, template or constant concatenation this script can read.`);
      continue;
    }
    if (site.rowFields === null) {
      problems.push(`${label} the row type could not be resolved from the type argument (an index signature, an imported or duplicated declaration, or a type this script cannot follow)`);
      continue;
    }
    const resolved = resolveDynamicSql(site.sql);
    const unresolved = /<DYN:(?!tier\.relation)[^>]+>/.exec(resolved);
    if (unresolved) {
      problems.push(`${label} cannot be probed: unresolved ${unresolved[0]} in the SQL. Teach resolveDynamicSql about it.`);
      continue;
    }
    const isSelect = isSelectStatement(resolved);
    if (!isSelect && !isReturningDmlStatement(resolved)) {
      problems.push(`${label} cannot be probed: only SELECT, WITH and INSERT/UPDATE/DELETE ... RETURNING statements are described.`);
      continue;
    }

    const projection = new Map<string, boolean>();
    let probeFailed = false;

    for (const relation of tierRelationsFor(resolved, site.rowType)) {
      const sql = relation ? resolved.replace(/<DYN:tier\.relation>/g, relation) : resolved;
      const leftover = /<DYN:[^>]+>/.exec(sql);
      if (leftover) {
        problems.push(`${label} cannot be probed: unresolved ${leftover[0]} in the SQL. Teach resolveDynamicSql about it.`);
        probeFailed = true;
        continue;
      }
      let columns: WireColumn[] | null = null;

      if (isSelect) {
        const result = await probeSelect(pool, sql);
        if (result.columns) {
          columns = result.columns.map((column) => ({
            name: column.name,
            wire: wireOf(column.pgType) ?? 'unknown',
            nullable: selectNullability(column, sql, catalog),
          }));
          for (const column of result.columns) {
            if (wireOf(column.pgType) === undefined) problems.push(`${label} column ${column.name} is pg type ${pgTypeByOid.get(column.pgType) ?? column.pgType}, which is not in WIRE_TYPE_BY_PG_TYPE`);
          }
        } else {
          problems.push(`${label} ${result.error ?? 'probe failed'} (relation ${relation ?? 'n/a'})`);
        }
      } else {
        const result = await probeDml(pool, sql);
        const items = result.typeOids ? returningItems(sql, catalog.columnsOf) : null;
        if (!result.typeOids) {
          problems.push(`${label} ${result.error ?? 'probe failed'}`);
        } else if (!items || items.length !== result.typeOids.length) {
          problems.push(`${label} RETURNING names (${items?.map((item) => item.name).join(',') ?? 'unresolved'}) do not line up with ${result.typeOids.length} reported types`);
        } else {
          const table = returningTable(sql);
          columns = items.map((item, index) => {
            const oid = result.typeOids?.[index] ?? '';
            if (wireOf(oid) === undefined) problems.push(`${label} column ${item.name} is pg type ${pgTypeByOid.get(oid) ?? oid}, which is not in WIRE_TYPE_BY_PG_TYPE`);
            return { name: item.name, wire: wireOf(oid) ?? 'unknown', nullable: returningNullability(item, table, catalog) };
          });
        }
      }

      if (!columns) {
        probeFailed = true;
        continue;
      }
      probed += 1;
      for (const column of columns) projection.set(column.name, true);
      observe(observations, site, columns);
    }
    if (!probeFailed) observations.get(`${site.file}|${site.rowType}`)?.projections.push(projection);
  }
  return { observations, problems, probed };
}

export interface Evaluation {
  failed: boolean;
  allowed: { finding: Finding; reason: string }[];
  real: Finding[];
  stale: string[];
  problems: string[];
}

export function evaluate(
  result: CheckResult,
  scan: { sites: number; untypedReads: UntypedRead[]; minSites: number },
  allowlist: Record<string, AllowedNarrowing>,
  onlyType?: string,
): Evaluation {
  const compared = compareObservations(result.observations, onlyType);
  const { allowed, real, stale } = applyAllowlist(compared.findings, allowlist, onlyType);
  const problems = [...result.problems, ...compared.problems];
  if (scan.sites < scan.minSites) {
    problems.push(`only ${scan.sites} typed query sites were found, fewer than the ${scan.minSites} recorded in floor.ts: statements may be hidden from the scan`);
  }
  for (const read of scan.untypedReads) {
    problems.push(`${read.file}:${read.line} reads the rows of a .query(...) with no row type, so they are not checked. Add a query<Row> type argument.`);
  }
  return { failed: real.length > 0 || problems.length > 0 || stale.length > 0, allowed, real, stale, problems };
}
