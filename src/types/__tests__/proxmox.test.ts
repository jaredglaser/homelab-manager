import { describe, it, expect } from 'bun:test';
import { isProxmoxEntityType, zProxmoxEntityType, type ProxmoxStatsRow } from '../proxmox';

/** The row type spells these out for check:row-types; the record below fails typecheck on a sixth. */
const rowEntityTypes = ['cluster', 'node', 'qemu', 'lxc', 'storage'] as const satisfies readonly ProxmoxStatsRow['entity_type'][];
const everyRowEntityType: Record<ProxmoxStatsRow['entity_type'], true> = {
  cluster: true,
  node: true,
  qemu: true,
  lxc: true,
  storage: true,
};

describe('proxmox_stats.entity_type', () => {
  it('keeps the row type and the schema on the same five values', () => {
    expect([...zProxmoxEntityType.options]).toEqual([...rowEntityTypes]);
    expect(Object.keys(everyRowEntityType)).toEqual([...rowEntityTypes]);
  });

  it('accepts every value the column can hold', () => {
    for (const value of rowEntityTypes) expect(isProxmoxEntityType(value)).toBe(true);
  });

  it('rejects anything else rather than narrowing it', () => {
    for (const value of ['vm', 'storage ', '', null, undefined, 3]) expect(isProxmoxEntityType(value)).toBe(false);
  });
});