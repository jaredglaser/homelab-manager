import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitSqlStatements } from '@/lib/database/migrate';

const migrationsDir = join(import.meta.dir, '..', '..', '..', '..', 'migrations');

const SOURCES = [
  { table: 'docker_stats', file: '030_docker_stats_retention_cascade.sql' },
  { table: 'zfs_stats', file: '031_zfs_stats_retention_cascade.sql' },
  { table: 'proxmox_stats', file: '032_proxmox_stats_retention_cascade.sql' },
];

function lastIndexWhere(values: string[], predicate: (value: string) => boolean): number {
  return values.reduce((found, value, index) => (predicate(value) ? index : found), -1);
}

function readMigration(file: string): string {
  return readFileSync(join(migrationsDir, file), 'utf-8');
}

/** Every `(x_sum / NULLIF(sample_count, 0))::double precision AS metric` in the averaged view. */
function weightedPairs(sql: string): { sumColumn: string; metric: string }[] {
  const pattern =
    /\((\w+_sum)\s*\/\s*NULLIF\(sample_count,\s*0\)\)::double precision\s+AS (\w+)/g;
  return [...sql.matchAll(pattern)].map((m) => ({ sumColumn: m[1], metric: m[2] }));
}

for (const { table, file } of SOURCES) describe(file, () => {
  const sql = readMigration(file);
  const statements = splitSqlStatements(sql);

  test('opts out of the transaction wrapper', () => {
    expect(sql.split('\n')[0].trim()).toBe('-- migrate:no-transaction');
  });

  test('cuts raw chunks to 1 hour so 24-hour retention can actually drop them', () => {
    expect(sql).toContain(`SELECT set_chunk_time_interval('${table}', INTERVAL '1 hour')`);
  });

  test('builds the hourly tier on the minute tier, never on raw', () => {
    const hourlyDefinition = sql.slice(sql.indexOf(`CREATE MATERIALIZED VIEW IF NOT EXISTS ${table}_1h\n`));
    expect(hourlyDefinition).toContain(`FROM ${table}_1m`);
    expect(hourlyDefinition.slice(0, hourlyDefinition.indexOf('WITH NO DATA'))).not.toContain(
      `FROM ${table}\n`,
    );
  });

  test('keeps every refresh window strictly inside its source retention', () => {
    expect(sql).toMatch(
      new RegExp(
        `add_continuous_aggregate_policy\\('${table}_1m',\\s*\\n\\s*start_offset\\s*=> INTERVAL '6 hours'`,
      ),
    );
    expect(sql).toMatch(
      new RegExp(
        `add_continuous_aggregate_policy\\('${table}_1h',\\s*\\n\\s*start_offset\\s*=> INTERVAL '3 days'`,
      ),
    );
    expect(sql).toContain(`add_retention_policy('${table}_1m', INTERVAL '30 days'`);
    expect(sql).toContain(`add_retention_policy('${table}', INTERVAL '24 hours'`);
  });

  test('never puts a retention policy on the hourly tier', () => {
    expect(sql).not.toContain(`add_retention_policy('${table}_1h'`);
  });

  test('counts samples per minute bucket so the hourly tier can weight them', () => {
    expect(sql).toContain('count(*)');
    expect(sql).toContain('AS sample_count');
  });

  test('weights each averaged metric by its sample count instead of averaging averages', () => {
    const pairs = weightedPairs(sql);
    expect(pairs.length).toBeGreaterThan(0);

    for (const { sumColumn, metric } of pairs) {
      expect(sql).toMatch(new RegExp(`SUM\\(${metric} \\* sample_count\\)\\s+AS ${sumColumn}\\b`));
      expect(sql).toMatch(new RegExp(`AVG\\(${metric}\\)\\s+AS ${metric}\\b`));
    }
    expect(sql).toContain('SUM(sample_count)');
  });

  test('drops raw only after every rollup statement has run', () => {
    const lastRefresh = lastIndexWhere(statements, (s) =>
      s.startsWith('CALL refresh_continuous_aggregate'),
    );
    const rawRetention = statements.findIndex(
      (s) => s.includes(`add_retention_policy('${table}'`) && s.includes("INTERVAL '24 hours'"),
    );
    expect(lastRefresh).toBeGreaterThan(0);
    expect(rawRetention).toBe(statements.length - 1);
    expect(rawRetention).toBeGreaterThan(lastRefresh);
  });

  test('sweeps all pre-existing history before the recent windows', () => {
    const refreshes = statements.filter((s) => s.startsWith('CALL refresh_continuous_aggregate'));
    expect(refreshes.length).toBeGreaterThan(2);

    for (const cagg of [`${table}_1m`, `${table}_1h`]) {
      const forCagg = refreshes.filter((s) => s.includes(`'${cagg}'`));
      expect(forCagg[0]).toBe(
        `CALL refresh_continuous_aggregate('${cagg}', NULL, now() - INTERVAL '30 days')`,
      );
      for (const windowed of forCagg.slice(1)) {
        expect(windowed).not.toContain('NULL');
        expect(windowed).toContain('now() - INTERVAL');
      }
    }
  });

  test('finishes the minute sweep before the hourly sweep that reads it', () => {
    const lastMinute = lastIndexWhere(statements, (s) =>
      s.startsWith(`CALL refresh_continuous_aggregate('${table}_1m'`),
    );
    const firstHour = statements.findIndex((s) =>
      s.startsWith(`CALL refresh_continuous_aggregate('${table}_1h'`),
    );
    expect(firstHour).toBeGreaterThan(lastMinute);
  });
});

describe('032_proxmox_stats_retention_cascade.sql counter columns', () => {
  const sql = readMigration('032_proxmox_stats_retention_cascade.sql');

  // netin/netout are cumulative byte counters from the Proxmox API and uptime is monotonic;
  // averaging any of them yields the bucket midpoint, which is a plausible-looking lie.
  test.each(['netin', 'netout', 'uptime'])('carries %s through last(), never AVG()', (column) => {
    expect(sql).not.toContain(`AVG(${column})`);
    expect(sql).not.toContain(`SUM(${column} * sample_count)`);
    expect(sql).toMatch(new RegExp(`last\\(${column}, time\\)\\s+AS ${column}\\b`));
  });

  test.each(['max_cpu', 'max_mem', 'max_disk'])('carries the %s constant through last()', (column) => {
    expect(sql).not.toContain(`AVG(${column})`);
    expect(sql).toMatch(new RegExp(`last\\(${column}, time\\)\\s+AS ${column}\\b`));
  });

  test('averages only the four true gauges', () => {
    expect(weightedPairs(sql).map((p) => p.metric).sort()).toEqual([
      'cpu',
      'disk',
      'mem',
      'storage_avail',
    ]);
  });
});
