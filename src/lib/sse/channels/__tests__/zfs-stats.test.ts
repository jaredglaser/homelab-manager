import { describe, it, expect } from 'bun:test';
import { zfsStatsChannel } from '../zfs-stats';

const wireRow = {
  time: '2026-04-16T10:00:00.000Z',
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

  it('accepts a Date instance for time (the preloadFn/ZFSStatsRow shape pre-serialization)', () => {
    const result = zfsStatsChannel.schema.safeParse([{ ...wireRow, time: new Date() }]);
    expect(result.success).toBe(true);
  });

  it('rejects a row missing required fields', () => {
    const result = zfsStatsChannel.schema.safeParse([{ host: 'server1' }]);
    expect(result.success).toBe(false);
  });

  it('revives time to an epoch-ms number', () => {
    const rows = zfsStatsChannel.schema.parse([wireRow]);
    const revived = zfsStatsChannel.revive(rows);

    expect(revived).toHaveLength(1);
    expect(revived[0].time).toBe(Date.parse(wireRow.time));
    expect(revived[0].pool).toBe('tank');
  });
});
