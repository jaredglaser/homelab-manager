import { describe, it, expect } from 'bun:test';
import { proxmoxStatsChannel } from '../proxmox-stats';

const wireRow = {
  time: '2026-04-16T10:00:00.000Z',
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
  netin: 10,
  netout: 20,
  storage_type: null,
  storage_content: null,
  storage_avail: null,
  storage_shared: null,
  cluster_version: null,
};

describe('proxmoxStatsChannel', () => {
  it('exposes the url and errorEvent used by the route and the client', () => {
    expect(proxmoxStatsChannel.url).toBe('/api/proxmox-stats');
    expect(proxmoxStatsChannel.errorEvent).toBe('stats_error');
  });

  it('validates an array of well-formed rows', () => {
    const result = proxmoxStatsChannel.schema.safeParse([wireRow]);
    expect(result.success).toBe(true);
  });

  it('accepts a Date instance for time (the preloadFn/ProxmoxStatsRow shape pre-serialization)', () => {
    const result = proxmoxStatsChannel.schema.safeParse([{ ...wireRow, time: new Date() }]);
    expect(result.success).toBe(true);
  });

  it('rejects an unknown entity_type', () => {
    const result = proxmoxStatsChannel.schema.safeParse([{ ...wireRow, entity_type: 'bogus' }]);
    expect(result.success).toBe(false);
  });

  it('revives time to an epoch-ms number', () => {
    const rows = proxmoxStatsChannel.schema.parse([wireRow]);
    const revived = proxmoxStatsChannel.revive(rows);

    expect(revived).toHaveLength(1);
    expect(revived[0].time).toBe(Date.parse(wireRow.time));
    expect(revived[0].entity_id).toBe('pve1');
  });
});
