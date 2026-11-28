import { describe, it, expect } from 'bun:test';
import { generateZFSHealthSnapshot } from '../zfs';
import { ZFS_ENTITIES } from '../../entities';
import { zZFSHostHealth } from '@/types/zfs';

describe('generateZFSHealthSnapshot', () => {
  const now = new Date('2026-11-27T12:00:00Z');

  it('gives every demo entity a health node on its own entity, on the channel schema', () => {
    const hosts = generateZFSHealthSnapshot(now);
    for (const host of hosts) expect(zZFSHostHealth.safeParse(host).success).toBe(true);
    const entities = hosts.flatMap((host) => host.pools.flatMap((pool) => pool.nodes.map((node) => `${host.host}/${node.entity}`)));
    expect(entities).toEqual(ZFS_ENTITIES.map((e) => `${e.host}/${e.entity}`));
  });

  it('has a degraded pool with a faulted disk that has errors, a running scrub and a finished one', () => {
    const pools = new Map(generateZFSHealthSnapshot(now)[0].pools.map((pool) => [pool.pool, pool]));
    const rust = pools.get('rust')!;
    expect(rust.nodes[0].state).toBe('degraded');
    expect(rust.nodes.find((node) => node.entity === 'rust/raidz2-0/sdf')).toMatchObject({ state: 'faulted', errors: { read: 3, write: 0, checksum: 12 } });
    expect(rust.scan).toMatchObject({ kind: 'scrub', state: 'finished', endedAt: now.getTime() - 4 * 24 * 60 * 60_000 });
    expect(pools.get('application')!.scan).toEqual({ kind: 'scrub', state: 'running', percentDone: 42, endedAt: null, repairedBytes: 0, errors: 0 });
    expect(pools.get('system')!.scan).toBeNull();
  });
});
