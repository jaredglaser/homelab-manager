import { describe, it, expect } from 'bun:test';
import { zfsHealthChannel } from '../zfs-health';
import type { ZFSHostHealth } from '@/types/zfs';

const host: ZFSHostHealth = {
  host: 'pve1',
  readable: true,
  connected: false,
  lastSeenAt: 1_700_000_000_000,
  pools: [{
    pool: 'tank',
    scan: { kind: 'scrub', state: 'running', percentDone: 42, endedAt: null, repairedBytes: 0, errors: 0 },
    nodes: [
      { entity: 'tank', entityType: 'pool', state: 'degraded', errors: null },
      { entity: 'tank/mirror-0/sda', entityType: 'disk', state: 'faulted', errors: { read: 3, write: 0, checksum: 12 } },
    ],
  }],
};

describe('zfsHealthChannel', () => {
  it('rides the zfs-health topic', () => {
    expect(zfsHealthChannel.topic).toBe('zfs-health');
  });

  it('accepts a snapshot of hosts, and an empty one', () => {
    expect(zfsHealthChannel.schema.parse({ hosts: [host] })).toEqual({ hosts: [host] });
    expect(zfsHealthChannel.schema.safeParse({ hosts: [] }).success).toBe(true);
  });

  it('rejects a state the page has no chip for', () => {
    const bad = { ...host, pools: [{ ...host.pools[0], nodes: [{ ...host.pools[0].nodes[0], state: 'bogus' }] }] };
    expect(zfsHealthChannel.schema.safeParse({ hosts: [bad] }).success).toBe(false);
  });
});
