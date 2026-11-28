import { describe, test, expect, beforeAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migrationsDir = join(import.meta.dir, '..', '..', '..', '..', 'migrations');
const FILE = '054_zfs_ssh_nodes.sql';

/** Behaviour against a real TimescaleDB is asserted by scripts/migration-verify (assertZfsLegacyEntities). */
describe(FILE, () => {
  let sql: string;

  beforeAll(() => {
    sql = readFileSync(join(migrationsDir, FILE), 'utf-8');
  });

  test('runs inside the standard transaction wrapper and leaves the refresh to the startup backfill', () => {
    expect(sql).not.toContain('-- migrate:no-transaction');
    expect(sql).not.toContain('refresh_continuous_aggregate');
  });

  test('strips only a leading segment that is not the pool, and only when the rest starts with the pool', () => {
    expect(sql).toContain("SET entity = substr(entity, strpos(entity, '/') + 1)");
    expect(sql).toContain("split_part(entity, '/', 1) <> pool");
    expect(sql).toContain("left(substr(entity, strpos(entity, '/') + 1), length(pool) + 1) = pool || '/'");
  });

  test('drops group header rows only for a pool name that never had capacity on that host', () => {
    expect(sql).toContain("WHERE z.pool IN ('special', 'dedup', 'logs', 'cache')");
    expect(sql).toContain('COALESCE(p.capacity_alloc, 0) + COALESCE(p.capacity_free, 0) > 0');
  });

  test('rebuilds every zfs aggregate tier and its policies, so no prefixed entity survives in a rollup', () => {
    for (const statement of [
      'DROP VIEW IF EXISTS zfs_stats_1h_avg;',
      'DROP MATERIALIZED VIEW IF EXISTS zfs_stats_1h;',
      'DROP MATERIALIZED VIEW IF EXISTS zfs_stats_1m;',
      'CREATE MATERIALIZED VIEW zfs_stats_1m',
      'CREATE MATERIALIZED VIEW zfs_stats_1h',
      'CREATE VIEW zfs_stats_1h_avg AS',
      "SELECT add_continuous_aggregate_policy('zfs_stats_1m',",
      "SELECT add_continuous_aggregate_policy('zfs_stats_1h',",
      "SELECT add_compression_policy('zfs_stats_1m', INTERVAL '7 days');",
      "SELECT add_compression_policy('zfs_stats_1h', INTERVAL '30 days');",
    ]) {
      expect(sql).toContain(statement);
    }
    expect(sql.indexOf('UPDATE zfs_stats')).toBeLessThan(sql.indexOf('CREATE MATERIALIZED VIEW zfs_stats_1m'));
  });

  test('decompresses raw chunks before rewriting entity, a segmentby column', () => {
    expect(sql.indexOf('decompress_chunk')).toBeLessThan(sql.indexOf('UPDATE zfs_stats'));
  });
});
