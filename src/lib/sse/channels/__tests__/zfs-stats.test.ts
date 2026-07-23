import { describe, it, expect } from 'bun:test';
import { zfsStatsChannel } from '../zfs-stats';

const wireRow = {
  time: Date.parse('2026-04-16T10:00:00.000Z'),
  host: 'server1',
  pool: 'tank',
  entity: 'tank',
  entity_type: 'pool',
  indent: 0,
  capacity_alloc: 1000,
  capacity_free: 2000,
  read_ops_per_sec: 10,
  write_ops_per_sec: 5,
  read_bytes_per_sec: 1024,
  write_bytes_per_sec: 512,
  utilization_percent: 33.3,
};

describe('zfsStatsChannel', () => {
  it('exposes the url and errorEvent used by the route and the client', () => {
    expect(zfsStatsChannel.url).toBe('/api/zfs-stats');
    expect(zfsStatsChannel.errorEvent).toBe('stats_error');
  });

  it('validates an array of well-formed rows', () => {
    const result = zfsStatsChannel.schema.safeParse([wireRow]);
    expect(result.success).toBe(true);
  });

  it('rejects a string time (repository read path now normalizes to epoch ms)', () => {
    const result = zfsStatsChannel.schema.safeParse([{ ...wireRow, time: '2026-04-16T10:00:00.000Z' }]);
    expect(result.success).toBe(false);
  });

  it('rejects a row missing required fields', () => {
    const result = zfsStatsChannel.schema.safeParse([{ host: 'server1' }]);
    expect(result.success).toBe(false);
  });

  it('has no revive step; the schema shape matches ZFSStatsRow directly', () => {
    expect(zfsStatsChannel.revive).toBeUndefined();
  });
});
