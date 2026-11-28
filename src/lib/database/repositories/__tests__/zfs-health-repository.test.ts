import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZfsHealthRepository } from '../zfs-health-repository';
import { createMockPool } from '@/lib/test/mock-pool';
import type { ZFSPoolHealth } from '@/types/zfs';

const TANK: ZFSPoolHealth = {
  pool: 'tank',
  scan: null,
  nodes: [
    { entity: 'tank', entityType: 'pool', state: 'degraded', errors: null },
    { entity: 'tank/sda', entityType: 'disk', state: 'faulted', errors: { read: 3, write: 0, checksum: 12 } },
  ],
};

describe('ZfsHealthRepository', () => {
  let repo: ZfsHealthRepository;
  let mock: ReturnType<typeof createMockPool>;
  let errorSpy: ReturnType<typeof spyOn<Console, 'error'>>;

  beforeEach(() => {
    mock = createMockPool();
    repo = new ZfsHealthRepository(mock.pool);
    errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('replaces the stored pools with the reported ones and marks the host readable and connected', async () => {
    await repo.recordHealth('pve1', [TANK]);

    expect(mock.queries[0].sql).toContain('ON CONFLICT (host) DO UPDATE');
    expect(mock.queries[0].sql).toContain('pools = EXCLUDED.pools');
    expect(mock.queries[0].params).toEqual(['pve1', JSON.stringify([TANK])]);
  });

  it('records unreadable health without touching the stored pools', async () => {
    await repo.recordUnreadable('pve1');

    expect(mock.queries[0].sql).toContain('readable = FALSE');
    expect(mock.queries[0].sql).not.toContain('pools =');
    expect(mock.queries[0].params).toEqual(['pve1']);
  });

  it('moves last seen only when the host was connected', async () => {
    await repo.recordDisconnected('pve1');

    expect(mock.queries[0].sql).toContain('WHERE host = $1 AND connected');
    expect(mock.queries[0].params).toEqual(['pve1']);
  });

  it('lists hosts that still collect ZFS with the last seen time as epoch ms', async () => {
    const seen = new Date('2026-11-27T10:42:00Z');
    mock.pushResult([{ host: 'pve1', readable: false, connected: false, pools: [TANK], last_seen_at: seen }]);

    expect(await repo.list()).toEqual([{ host: 'pve1', readable: false, connected: false, lastSeenAt: seen.getTime(), pools: [TANK] }]);
    expect(mock.queries[0].sql).toContain("m.capabilities->>'zfs' = 'true'");
  });

  it('leaves out and logs a host whose stored pools are off the schema', async () => {
    const seen = new Date();
    mock.pushResult([
      { host: 'bad', readable: true, connected: true, pools: [{ pool: 'tank' }], last_seen_at: seen },
      { host: 'good', readable: true, connected: true, pools: [], last_seen_at: seen },
    ]);

    expect((await repo.list()).map((host) => host.host)).toEqual(['good']);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('notifies on every insert, update and delete from the migration trigger', () => {
    const sql = readFileSync(join(import.meta.dir, '../../../../../migrations/053_zfs_host_health.sql'), 'utf-8');
    expect(sql).toContain("pg_notify('zfs_health_change', NEW.host)");
    expect(sql).toContain('AFTER INSERT OR UPDATE OR DELETE ON zfs_host_health');
    expect(sql).toContain('REFERENCES managed_hosts (name) ON DELETE CASCADE ON UPDATE CASCADE');
  });
});
