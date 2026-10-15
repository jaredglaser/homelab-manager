import { describe, test, expect, beforeAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migrationsDir = join(import.meta.dir, '..', '..', '..', '..', 'migrations');
const FILE = '037_backfill_container_service_keys.sql';

describe(FILE, () => {
  let sql: string;

  beforeAll(() => {
    sql = readFileSync(join(migrationsDir, FILE), 'utf-8');
  });

  test('runs inside the standard transaction wrapper', () => {
    expect(sql).not.toContain('-- migrate:no-transaction');
  });

  test('reads the aggregate tiers, not 24-hour raw', () => {
    expect(sql).toContain('FROM docker_stats_1m');
    expect(sql).toContain('FROM docker_stats_1h_avg');
    expect(sql).not.toContain('FROM docker_stats\n');
  });

  test('never clobbers rows the live collectors wrote', () => {
    expect(sql).toContain('ON CONFLICT (source, entity, key) DO NOTHING');
  });

  test('derives service_key from container name, matching the stats collector convention', () => {
    expect(sql).toMatch(/CASE k\.key WHEN 'image' THEN s\.image ELSE s\.container_name END/);
    expect(sql).toContain("('name'), ('image'), ('service_key')");
  });

  test('groups per host and container ID with the latest name winning', () => {
    expect(sql).toContain('DISTINCT ON (host, container_id)');
    expect(sql).toContain('ORDER BY host, container_id, time DESC');
  });

  test('skips rows with no container name instead of inserting null keys', () => {
    expect(sql).toContain('WHERE container_name IS NOT NULL');
  });
});
