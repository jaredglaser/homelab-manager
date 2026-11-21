import type { Pool } from 'pg';

export interface ProbedColumn {
  name: string;
  pgType: string;
  /** Source relation and attribute number, or 0 for a computed column. */
  tableID: number;
  columnID: number;
}

export interface ProbeResult {
  columns?: ProbedColumn[];
  typeOids?: string[];
  error?: string;
}

export const TIER_BASE_BY_ROW_TYPE: Readonly<Record<string, string | undefined>> = {
  DockerStatsQueryRow: 'docker_stats',
  ZFSStatsQueryRow: 'zfs_stats',
  ProxmoxStatsQueryRow: 'proxmox_stats',
};

export function isSelectStatement(sql: string): boolean {
  return /^\s*(select|with)/i.test(sql);
}

export function isReturningDmlStatement(sql: string): boolean {
  return /^\s*(insert|update|delete)/i.test(sql) && /RETURNING/i.test(sql);
}

export function tierRelationsFor(sql: string, rowType: string): (string | null)[] {
  if (!sql.includes('<DYN:tier.relation>')) return [null];
  const base = TIER_BASE_BY_ROW_TYPE[rowType] ?? 'docker_stats';
  return [base, `${base}_1m`, `${base}_1h_avg`];
}

// A marker left over fails the run: the statement would otherwise be probed as something the repository does not run.
export function resolveDynamicSql(sql: string): string {
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

/** Runs a SELECT with the parameters nulled out and reads the result description. */
export async function probeSelect(pool: Pool, sql: string): Promise<ProbeResult> {
  const parameterCount = [...sql.matchAll(/\$(\d+)/g)].reduce((max, m) => Math.max(max, Number(m[1])), 0);
  const values = Array.from({ length: parameterCount }, () => null);
  const wrapped = `SELECT * FROM (\n${sql.replace(/;\s*$/, '')}\n) AS __row_wire_probe LIMIT 0`;
  try {
    const result = await pool.query({ text: wrapped, values });
    return { columns: result.fields.map((field) => ({ name: field.name, pgType: String(field.dataTypeID), tableID: field.tableID, columnID: field.columnID })) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// PREPARE describes the statement. Executing it to learn the types would write.
export async function probeDml(pool: Pool, sql: string): Promise<ProbeResult> {
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

export interface ReturningItem {
  name: string;
  plain: boolean;
}

export function returningItems(sql: string, columnsOf: (table: string) => string[]): ReturningItem[] | null {
  const match = /RETURNING\s+([\s\S]+?)\s*(?:;|$)/i.exec(sql);
  if (!match) return null;
  const items: ReturningItem[] = [];
  for (const item of match[1].split(',').map((part) => part.trim()).filter(Boolean)) {
    if (item === '*') {
      const table = returningTable(sql);
      if (!table) return null;
      items.push(...columnsOf(table).map((name) => ({ name, plain: true })));
      continue;
    }
    const alias = /\s+AS\s+([a-z0-9_]+)\s*$/i.exec(item);
    const name = (alias ? alias[1] : item.replace(/[()]/g, '').split('.').pop() ?? item).trim();
    items.push({ name, plain: !alias && /^[a-z0-9_.]+$/i.test(item) });
  }
  return items;
}

export function returningTable(sql: string): string | undefined {
  return /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|FROM)\s+([a-z0-9_]+)/i.exec(sql)?.[1];
}

export function returningNames(sql: string, columnsOf: (table: string) => string[]): string[] | null {
  return returningItems(sql, columnsOf)?.map((item) => item.name) ?? null;
}
