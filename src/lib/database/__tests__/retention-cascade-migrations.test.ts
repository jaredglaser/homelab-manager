import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migrationsDir = join(import.meta.dir, '..', '..', '..', '..', 'migrations');

const SOURCES = [
  { table: 'docker_stats', file: '030_docker_stats_retention_cascade.sql' },
  { table: 'zfs_stats', file: '031_zfs_stats_retention_cascade.sql' },
  { table: 'proxmox_stats', file: '032_proxmox_stats_retention_cascade.sql' },
];

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

  test('runs inside the standard transaction wrapper', () => {
    expect(sql).not.toContain('-- migrate:no-transaction');
  });

  test('leaves the backfill to the startup task', () => {
    expect(sql).not.toContain('refresh_continuous_aggregate(');
  });

  test('leaves retention to the startup task, which adds it only after a backfill', () => {
    expect(sql).not.toContain('add_retention_policy(');
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

  test('compresses both tiers and shortens raw compression to 6 hours', () => {
    expect(sql).toContain(`add_compression_policy('${table}_1m', INTERVAL '7 days'`);
    expect(sql).toContain(`add_compression_policy('${table}_1h', INTERVAL '30 days'`);
    expect(sql).toContain(`add_compression_policy('${table}', INTERVAL '6 hours'`);
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
