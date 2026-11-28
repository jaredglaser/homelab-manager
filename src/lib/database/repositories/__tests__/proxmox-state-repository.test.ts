import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import { ProxmoxStateRepository } from '../proxmox-state-repository';
import { resetDegradedRowEnums } from '../row-enum';
import { createMockPool } from '@/lib/test/mock-pool';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROXMOX_COLLECTOR_STATES } from '@/types/proxmox';

describe('ProxmoxStateRepository', () => {
  let repo: ProxmoxStateRepository;
  let mock: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    resetDegradedRowEnums();
    mock = createMockPool();
    repo = new ProxmoxStateRepository(mock.pool);
  });

  it('upserts one row per connection and keeps the stored last success when none is given', async () => {
    await repo.record({
      connectionId: 'pve.lan',
      host: 'pve.lan',
      port: 8006,
      state: 'unreachable',
      reason: '/cluster/status: Connection refused',
      lastSuccessAt: null,
    });

    expect(mock.queries).toHaveLength(1);
    expect(mock.queries[0].sql).toContain('ON CONFLICT (connection_id) DO UPDATE');
    expect(mock.queries[0].sql).toContain('COALESCE(EXCLUDED.last_success_at, proxmox_collector_state.last_success_at)');
    expect(mock.queries[0].params).toEqual(['pve.lan', 'pve.lan', 8006, 'unreachable', '/cluster/status: Connection refused', null]);
  });

  it('deletes the rows of connections that are no longer saved', async () => {
    await repo.removeOrphans();

    expect(mock.queries[0].sql).toContain('DELETE FROM proxmox_collector_state');
    expect(mock.queries[0].sql).toContain('NOT EXISTS (SELECT 1 FROM proxmox_connections c WHERE c.id::text = s.connection_id)');
  });

  it('lists every saved connection, reading one the worker has not reported on yet as collecting', async () => {
    await repo.list();

    expect(mock.queries[0].sql).toContain('FROM proxmox_connections c');
    expect(mock.queries[0].sql).toContain('LEFT JOIN proxmox_collector_state s ON s.connection_id = c.id::text');
    expect(mock.queries[0].sql).toContain("COALESCE(s.state, 'collecting')");
  });

  it('lists the rows with times as epoch ms', async () => {
    const lastSuccess = new Date('2026-11-27T10:42:00Z');
    const updated = new Date('2026-11-27T10:43:00Z');
    mock.pushResult([{
      connection_id: 'pve.lan', host: 'pve.lan', port: 8006, state: 'unreachable',
      reason: 'timeout', last_success_at: lastSuccess, updated_at: updated,
    }]);

    expect(await repo.list()).toEqual([{
      connectionId: 'pve.lan', host: 'pve.lan', port: 8006, state: 'unreachable',
      reason: 'timeout', lastSuccessAt: lastSuccess.getTime(), updatedAt: updated.getTime(),
    }]);
  });

  it('skips a row whose state this build does not know, instead of failing the read', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      mock.pushResult([{
        connection_id: 'pve.lan', host: 'pve.lan', port: 8006, state: 'paused',
        reason: null, last_success_at: null, updated_at: new Date(),
      }]);

      expect(await repo.list()).toEqual([]);
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('proxmox_collector_state.state');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('proxmox_collector_state CHECK', () => {
  it('allows exactly the states the worker writes and the page has a notice for', () => {
    const sql = readFileSync(join(import.meta.dir, '../../../../../migrations/055_proxmox_connections.sql'), 'utf-8');
    const list = /state IN \(([^)]*)\)/.exec(sql)?.[1] ?? '';
    expect(list.split(',').map((v) => v.trim().replace(/'/g, ''))).toEqual([...PROXMOX_COLLECTOR_STATES]);
  });
});
