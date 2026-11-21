import { describe, it, expect } from 'bun:test';
import { isProxmoxEntityType, zProxmoxEntityType } from '../proxmox';

describe('proxmox_stats.entity_type', () => {
  it('accepts every value the schema lists', () => {
    expect(zProxmoxEntityType.options).toEqual(['cluster', 'node', 'qemu', 'lxc', 'storage']);
    for (const value of zProxmoxEntityType.options) expect(isProxmoxEntityType(value)).toBe(true);
  });

  it('rejects anything else rather than narrowing it', () => {
    for (const value of ['vm', 'storage ', '', null, undefined, 3]) expect(isProxmoxEntityType(value)).toBe(false);
  });
});
