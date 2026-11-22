import { describe, it, expect } from 'bun:test';
import { PROXMOX_ENTITY_TYPE_VALUES } from '../proxmox';

describe('proxmox_stats.entity_type', () => {
  it('lists the five entity types the collector writes', () => {
    expect([...PROXMOX_ENTITY_TYPE_VALUES]).toEqual(['cluster', 'node', 'qemu', 'lxc', 'storage']);
  });
});
