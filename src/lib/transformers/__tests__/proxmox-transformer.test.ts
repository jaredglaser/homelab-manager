import { describe, it, expect } from 'bun:test';
import {
  transformProxmoxStats,
  parseProxmoxEntityPath,
} from '../proxmox-transformer';
import type { LatestStatRow } from '@/lib/database/repositories/stats-repository';
import type { EntityMetadata } from '../docker-transformer';

function createRow(overrides: Partial<LatestStatRow> = {}): LatestStatRow {
  return {
    timestamp: new Date('2024-01-01T00:00:00Z'),
    type: 'cpu_percent',
    entity: 'pve1',
    value: 25,
    ...overrides,
  };
}

describe('parseProxmoxEntityPath', () => {
  it('should parse node entity path', () => {
    const result = parseProxmoxEntityPath('pve1');
    expect(result.node).toBe('pve1');
    expect(result.entityType).toBe('node');
    expect(result.vmid).toBeNull();
  });

  it('should parse QEMU VM entity path', () => {
    const result = parseProxmoxEntityPath('pve1/qemu/100');
    expect(result.node).toBe('pve1');
    expect(result.entityType).toBe('qemu');
    expect(result.vmid).toBe(100);
  });

  it('should parse LXC container entity path', () => {
    const result = parseProxmoxEntityPath('pve1/lxc/101');
    expect(result.node).toBe('pve1');
    expect(result.entityType).toBe('lxc');
    expect(result.vmid).toBe(101);
  });

  it('should handle multi-word node names', () => {
    const result = parseProxmoxEntityPath('my-pve-node/qemu/200');
    expect(result.node).toBe('my-pve-node');
    expect(result.entityType).toBe('qemu');
    expect(result.vmid).toBe(200);
  });
});

describe('transformProxmoxStats', () => {
  it('should transform node stats', () => {
    const rows: LatestStatRow[] = [
      createRow({ entity: 'pve1', type: 'cpu_percent', value: 25 }),
      createRow({ entity: 'pve1', type: 'memory_usage', value: 1024 * 1024 * 512 }),
      createRow({ entity: 'pve1', type: 'memory_limit', value: 1024 * 1024 * 1024 }),
      createRow({ entity: 'pve1', type: 'memory_percent', value: 50 }),
      createRow({ entity: 'pve1', type: 'uptime', value: 86400 }),
      createRow({ entity: 'pve1', type: 'status', value: 1 }),
    ];

    const metadata: EntityMetadata = new Map();
    metadata.set('pve1', new Map([['name', 'pve1'], ['type', 'node'], ['status', 'online']]));

    const result = transformProxmoxStats(rows, metadata);

    expect(result.size).toBe(1);
    const node = result.get('pve1')!;
    expect(node.entityType).toBe('node');
    expect(node.name).toBe('pve1');
    expect(node.rates.cpuPercent).toBe(25);
    expect(node.rates.memoryUsage).toBe(1024 * 1024 * 512);
    expect(node.rates.memoryPercent).toBe(50);
    expect(node.rates.uptime).toBe(86400);
    expect(node.status).toBe('running');
  });

  it('should transform guest stats', () => {
    const rows: LatestStatRow[] = [
      createRow({ entity: 'pve1/qemu/100', type: 'cpu_percent', value: 50 }),
      createRow({ entity: 'pve1/qemu/100', type: 'memory_usage', value: 256 * 1024 * 1024 }),
      createRow({ entity: 'pve1/qemu/100', type: 'network_in_bytes_per_sec', value: 1024 * 100 }),
      createRow({ entity: 'pve1/qemu/100', type: 'network_out_bytes_per_sec', value: 1024 * 50 }),
    ];

    const metadata: EntityMetadata = new Map();
    metadata.set('pve1/qemu/100', new Map([
      ['name', 'my-vm'],
      ['type', 'qemu'],
      ['status', 'running'],
      ['ip_addresses', '192.168.1.100,10.0.0.5'],
      ['tags', 'web,production'],
    ]));

    const result = transformProxmoxStats(rows, metadata);

    expect(result.size).toBe(1);
    const vm = result.get('pve1/qemu/100')!;
    expect(vm.entityType).toBe('qemu');
    expect(vm.name).toBe('my-vm');
    expect(vm.vmid).toBe(100);
    expect(vm.node).toBe('pve1');
    expect(vm.rates.cpuPercent).toBe(50);
    expect(vm.rates.networkInBytesPerSec).toBe(1024 * 100);
    expect(vm.ipAddresses).toEqual(['192.168.1.100', '10.0.0.5']);
    expect(vm.tags).toEqual(['web', 'production']);
  });

  it('should group rows by entity', () => {
    const rows: LatestStatRow[] = [
      createRow({ entity: 'pve1', type: 'cpu_percent', value: 25 }),
      createRow({ entity: 'pve1/qemu/100', type: 'cpu_percent', value: 50 }),
      createRow({ entity: 'pve1/lxc/101', type: 'cpu_percent', value: 10 }),
    ];

    const result = transformProxmoxStats(rows);

    expect(result.size).toBe(3);
    expect(result.has('pve1')).toBe(true);
    expect(result.has('pve1/qemu/100')).toBe(true);
    expect(result.has('pve1/lxc/101')).toBe(true);
  });

  it('should use most recent timestamp', () => {
    const rows: LatestStatRow[] = [
      createRow({ entity: 'pve1', type: 'cpu_percent', value: 25, timestamp: new Date('2024-01-01T00:00:00Z') }),
      createRow({ entity: 'pve1', type: 'memory_percent', value: 50, timestamp: new Date('2024-01-01T00:01:00Z') }),
    ];

    const result = transformProxmoxStats(rows);
    const node = result.get('pve1')!;

    expect(node.timestamp.toISOString()).toBe('2024-01-01T00:01:00.000Z');
  });

  it('should handle empty rows', () => {
    const result = transformProxmoxStats([]);
    expect(result.size).toBe(0);
  });

  it('should handle unknown stat types', () => {
    const rows: LatestStatRow[] = [
      createRow({ entity: 'pve1', type: 'unknown_type', value: 42 }),
    ];

    const result = transformProxmoxStats(rows);
    expect(result.size).toBe(1);
    // Unknown type should be silently ignored
    const node = result.get('pve1')!;
    expect(node.rates.cpuPercent).toBe(0);
  });

  it('should default values without metadata', () => {
    const rows: LatestStatRow[] = [
      createRow({ entity: 'pve1/lxc/101', type: 'cpu_percent', value: 10 }),
    ];

    const result = transformProxmoxStats(rows);
    const lxc = result.get('pve1/lxc/101')!;

    expect(lxc.name).toBe('lxc/101');
    expect(lxc.status).toBe('unknown');
    expect(lxc.tags).toEqual([]);
    expect(lxc.ipAddresses).toEqual([]);
  });

  it('should handle status value mapping', () => {
    const runningRows: LatestStatRow[] = [
      createRow({ entity: 'pve1/qemu/100', type: 'status', value: 1 }),
    ];
    const stoppedRows: LatestStatRow[] = [
      createRow({ entity: 'pve1/qemu/101', type: 'status', value: 0 }),
    ];

    const runningResult = transformProxmoxStats(runningRows);
    const stoppedResult = transformProxmoxStats(stoppedRows);

    expect(runningResult.get('pve1/qemu/100')!.status).toBe('running');
    expect(stoppedResult.get('pve1/qemu/101')!.status).toBe('stopped');
  });

  it('should handle all disk stat types', () => {
    const rows: LatestStatRow[] = [
      createRow({ entity: 'pve1/qemu/100', type: 'disk_usage', value: 5 * 1024 * 1024 * 1024 }),
      createRow({ entity: 'pve1/qemu/100', type: 'disk_limit', value: 20 * 1024 * 1024 * 1024 }),
      createRow({ entity: 'pve1/qemu/100', type: 'disk_read_bytes_per_sec', value: 1024 * 100 }),
      createRow({ entity: 'pve1/qemu/100', type: 'disk_write_bytes_per_sec', value: 1024 * 50 }),
    ];

    const result = transformProxmoxStats(rows);
    const vm = result.get('pve1/qemu/100')!;

    expect(vm.rates.diskUsage).toBe(5 * 1024 * 1024 * 1024);
    expect(vm.rates.diskLimit).toBe(20 * 1024 * 1024 * 1024);
    expect(vm.rates.diskReadBytesPerSec).toBe(1024 * 100);
    expect(vm.rates.diskWriteBytesPerSec).toBe(1024 * 50);
  });
});
