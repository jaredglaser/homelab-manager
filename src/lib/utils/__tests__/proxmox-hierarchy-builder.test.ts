import { describe, it, expect } from 'bun:test';
import {
  buildProxmoxHierarchy,
  aggregateNodeStats,
  formatUptime,
} from '../proxmox-hierarchy-builder';
import type { ProxmoxStatsFromDB } from '@/lib/transformers/proxmox-transformer';

function createStat(overrides: Partial<ProxmoxStatsFromDB> = {}): ProxmoxStatsFromDB {
  return {
    id: 'pve1',
    entityType: 'node',
    name: 'pve1',
    vmid: null,
    node: 'pve1',
    status: 'online',
    stale: false,
    timestamp: new Date(),
    tags: [],
    ipAddresses: [],
    rates: {
      cpuPercent: 25,
      memoryUsage: 1024 * 1024 * 512,
      memoryLimit: 1024 * 1024 * 1024,
      memoryPercent: 50,
      diskUsage: 1024 * 1024 * 1024 * 5,
      diskLimit: 1024 * 1024 * 1024 * 20,
      networkInBytesPerSec: 1024 * 100,
      networkOutBytesPerSec: 1024 * 50,
      diskReadBytesPerSec: 1024 * 200,
      diskWriteBytesPerSec: 1024 * 100,
      uptime: 86400,
    },
    ...overrides,
  };
}

describe('buildProxmoxHierarchy', () => {
  it('should build hierarchy from flat stats', () => {
    const stats: ProxmoxStatsFromDB[] = [
      createStat({ id: 'pve1', entityType: 'node', node: 'pve1' }),
      createStat({ id: 'pve1/qemu/100', entityType: 'qemu', node: 'pve1', vmid: 100, name: 'vm1' }),
      createStat({ id: 'pve1/lxc/101', entityType: 'lxc', node: 'pve1', vmid: 101, name: 'ct1' }),
    ];

    const hierarchy = buildProxmoxHierarchy(stats);

    expect(hierarchy.size).toBe(1);
    const nodeEntry = hierarchy.get('pve1')!;
    expect(nodeEntry.data.entityType).toBe('node');
    expect(nodeEntry.guests.size).toBe(2);
    expect(nodeEntry.guests.has('pve1/qemu/100')).toBe(true);
    expect(nodeEntry.guests.has('pve1/lxc/101')).toBe(true);
  });

  it('should handle multiple nodes', () => {
    const stats: ProxmoxStatsFromDB[] = [
      createStat({ id: 'pve1', entityType: 'node', node: 'pve1' }),
      createStat({ id: 'pve2', entityType: 'node', node: 'pve2', name: 'pve2' }),
      createStat({ id: 'pve1/qemu/100', entityType: 'qemu', node: 'pve1', vmid: 100 }),
      createStat({ id: 'pve2/lxc/200', entityType: 'lxc', node: 'pve2', vmid: 200 }),
    ];

    const hierarchy = buildProxmoxHierarchy(stats);

    expect(hierarchy.size).toBe(2);
    expect(hierarchy.get('pve1')!.guests.size).toBe(1);
    expect(hierarchy.get('pve2')!.guests.size).toBe(1);
  });

  it('should create placeholder node for orphan guests', () => {
    const stats: ProxmoxStatsFromDB[] = [
      createStat({ id: 'pve1/qemu/100', entityType: 'qemu', node: 'pve1', vmid: 100 }),
    ];

    const hierarchy = buildProxmoxHierarchy(stats);

    expect(hierarchy.size).toBe(1);
    const nodeEntry = hierarchy.get('pve1')!;
    expect(nodeEntry.data.entityType).toBe('node');
    expect(nodeEntry.data.status).toBe('unknown');
    expect(nodeEntry.guests.size).toBe(1);
  });

  it('should handle empty stats', () => {
    const hierarchy = buildProxmoxHierarchy([]);
    expect(hierarchy.size).toBe(0);
  });

  it('should handle node with no guests', () => {
    const stats: ProxmoxStatsFromDB[] = [
      createStat({ id: 'pve1', entityType: 'node', node: 'pve1' }),
    ];

    const hierarchy = buildProxmoxHierarchy(stats);
    expect(hierarchy.size).toBe(1);
    expect(hierarchy.get('pve1')!.guests.size).toBe(0);
  });
});

describe('aggregateNodeStats', () => {
  it('should count guests correctly', () => {
    const stats: ProxmoxStatsFromDB[] = [
      createStat({ id: 'pve1', entityType: 'node', node: 'pve1' }),
      createStat({ id: 'pve1/qemu/100', entityType: 'qemu', node: 'pve1', vmid: 100, status: 'running' }),
      createStat({ id: 'pve1/qemu/101', entityType: 'qemu', node: 'pve1', vmid: 101, status: 'stopped' }),
      createStat({ id: 'pve1/lxc/200', entityType: 'lxc', node: 'pve1', vmid: 200, status: 'running' }),
    ];

    const hierarchy = buildProxmoxHierarchy(stats);
    const agg = aggregateNodeStats(hierarchy.get('pve1')!);

    expect(agg.guestCount).toBe(3);
    expect(agg.runningCount).toBe(2);
    expect(agg.stoppedCount).toBe(1);
  });

  it('should use node stats for CPU and memory', () => {
    const stats: ProxmoxStatsFromDB[] = [
      createStat({
        id: 'pve1', entityType: 'node', node: 'pve1',
        rates: {
          cpuPercent: 75,
          memoryUsage: 8 * 1024 * 1024 * 1024,
          memoryLimit: 16 * 1024 * 1024 * 1024,
          memoryPercent: 50,
          diskUsage: 100 * 1024 * 1024 * 1024,
          diskLimit: 500 * 1024 * 1024 * 1024,
          networkInBytesPerSec: 0,
          networkOutBytesPerSec: 0,
          diskReadBytesPerSec: 0,
          diskWriteBytesPerSec: 0,
          uptime: 172800,
        },
      }),
    ];

    const hierarchy = buildProxmoxHierarchy(stats);
    const agg = aggregateNodeStats(hierarchy.get('pve1')!);

    expect(agg.cpuPercent).toBe(75);
    expect(agg.memoryUsage).toBe(8 * 1024 * 1024 * 1024);
    expect(agg.memoryLimit).toBe(16 * 1024 * 1024 * 1024);
    expect(agg.uptime).toBe(172800);
  });

  it('should sum guest network stats', () => {
    const stats: ProxmoxStatsFromDB[] = [
      createStat({ id: 'pve1', entityType: 'node', node: 'pve1' }),
      createStat({
        id: 'pve1/qemu/100', entityType: 'qemu', node: 'pve1', vmid: 100, status: 'running',
        rates: {
          cpuPercent: 10, memoryUsage: 0, memoryLimit: 0, memoryPercent: 0,
          diskUsage: 0, diskLimit: 0,
          networkInBytesPerSec: 1000, networkOutBytesPerSec: 500,
          diskReadBytesPerSec: 2000, diskWriteBytesPerSec: 1000,
          uptime: 0,
        },
      }),
      createStat({
        id: 'pve1/lxc/200', entityType: 'lxc', node: 'pve1', vmid: 200, status: 'running',
        rates: {
          cpuPercent: 5, memoryUsage: 0, memoryLimit: 0, memoryPercent: 0,
          diskUsage: 0, diskLimit: 0,
          networkInBytesPerSec: 3000, networkOutBytesPerSec: 1500,
          diskReadBytesPerSec: 4000, diskWriteBytesPerSec: 2000,
          uptime: 0,
        },
      }),
    ];

    const hierarchy = buildProxmoxHierarchy(stats);
    const agg = aggregateNodeStats(hierarchy.get('pve1')!);

    expect(agg.networkInBytesPerSec).toBe(4000);
    expect(agg.networkOutBytesPerSec).toBe(2000);
    expect(agg.diskReadBytesPerSec).toBe(6000);
    expect(agg.diskWriteBytesPerSec).toBe(3000);
  });
});

describe('formatUptime', () => {
  it('should return — for zero', () => {
    expect(formatUptime(0)).toBe('—');
  });

  it('should return — for negative', () => {
    expect(formatUptime(-1)).toBe('—');
  });

  it('should format minutes', () => {
    expect(formatUptime(300)).toBe('5m');
  });

  it('should format hours and minutes', () => {
    expect(formatUptime(3660)).toBe('1h 1m');
  });

  it('should format days and hours', () => {
    expect(formatUptime(90000)).toBe('1d 1h');
  });

  it('should format multiple days', () => {
    expect(formatUptime(259200)).toBe('3d 0h');
  });
});
