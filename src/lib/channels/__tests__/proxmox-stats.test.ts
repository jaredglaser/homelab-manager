import { describe, it, expect } from 'bun:test';
import { proxmoxStatsChannel } from '../proxmox-stats';

const wireRow = {
  time: Date.parse('2026-04-16T10:00:00.000Z'),
  host: 'server1',
  entity_type: 'node' as const,
  node: 'pve1',
  entity_id: 'pve1',
  entity_name: 'pve1',
  status: 'online',
  cpu: 0.1,
  max_cpu: 8,
  mem: 1024,
  max_mem: 2048,
  disk: 100,
  max_disk: 200,
  uptime: 3600,
  vmid: null,
  net_in_bytes_per_sec: 10,
  net_out_bytes_per_sec: 20,
  disk_read_bytes_per_sec: null,
  disk_write_bytes_per_sec: null,
  storage_type: null,
  storage_content: null,
  storage_avail: null,
  storage_shared: null,
  cluster_version: null,
};

describe('proxmoxStatsChannel', () => {
  it('validates an array of well-formed rows', () => {
    const result = proxmoxStatsChannel.schema.safeParse([wireRow]);
    expect(result.success).toBe(true);
  });

  it('rejects a string time (repository read path now normalizes to epoch ms)', () => {
    const result = proxmoxStatsChannel.schema.safeParse([{ ...wireRow, time: '2026-04-16T10:00:00.000Z' }]);
    expect(result.success).toBe(false);
  });

  it('rejects an unknown entity_type', () => {
    const result = proxmoxStatsChannel.schema.safeParse([{ ...wireRow, entity_type: 'bogus' }]);
    expect(result.success).toBe(false);
  });

  it('rejects a row without the rate columns', () => {
    const { net_in_bytes_per_sec: _rate, ...withoutRate } = wireRow;
    expect(proxmoxStatsChannel.schema.safeParse([withoutRate]).success).toBe(false);
  });

  it('has no revive step; the schema shape matches ProxmoxStatsRow directly', () => {
    expect(proxmoxStatsChannel.revive).toBeUndefined();
  });
});
