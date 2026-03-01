import { describe, it, expect } from 'bun:test';
import { overviewToRows } from '../proxmox-overview-converter';
import type { ProxmoxClusterOverview } from '@/types/proxmox';

function createMockOverview(): ProxmoxClusterOverview {
  return {
    clusterName: 'test-cluster',
    quorate: true,
    version: 5,
    nodes: [
      {
        node: 'pve1',
        status: 'online',
        cpu: 0.25,
        maxcpu: 8,
        mem: 4_000_000_000,
        maxmem: 16_000_000_000,
        disk: 50_000_000_000,
        maxdisk: 500_000_000_000,
        uptime: 86400,
        type: 'node',
        id: 'node/pve1',
      },
      {
        node: 'pve2',
        status: 'offline',
        cpu: 0,
        maxcpu: 4,
        mem: 0,
        maxmem: 8_000_000_000,
        disk: 0,
        maxdisk: 250_000_000_000,
        uptime: 0,
        type: 'node',
        id: 'node/pve2',
      },
    ],
    vms: [
      {
        vmid: 100,
        name: 'ubuntu-vm',
        status: 'running',
        cpu: 0.5,
        cpus: 4,
        mem: 2_000_000_000,
        maxmem: 4_000_000_000,
        disk: 10_000_000_000,
        maxdisk: 50_000_000_000,
        uptime: 3600,
        netin: 1_000_000,
        netout: 500_000,
        diskread: 100,
        diskwrite: 200,
        node: 'pve1',
      },
    ],
    containers: [
      {
        vmid: 200,
        name: 'nginx-ct',
        status: 'running',
        type: 'lxc',
        cpu: 0.1,
        cpus: 2,
        mem: 512_000_000,
        maxmem: 1_000_000_000,
        disk: 1_000_000_000,
        maxdisk: 5_000_000_000,
        uptime: 7200,
        netin: 200_000,
        netout: 100_000,
        diskread: 50,
        diskwrite: 25,
        swap: 0,
        maxswap: 512_000_000,
        node: 'pve1',
      },
    ],
    storages: [
      {
        storage: 'local',
        type: 'dir',
        content: 'rootdir,images',
        active: 1,
        enabled: 1,
        shared: 0,
        used: 20_000_000_000,
        avail: 80_000_000_000,
        total: 100_000_000_000,
        used_fraction: 0.2,
        node: 'pve1',
      },
    ],
    totals: {
      totalCpu: 12,
      usedCpu: 2,
      totalMemory: 24_000_000_000,
      usedMemory: 4_000_000_000,
      totalDisk: 750_000_000_000,
      usedDisk: 50_000_000_000,
      runningVMs: 1,
      stoppedVMs: 0,
      runningContainers: 1,
      stoppedContainers: 0,
    },
  };
}

describe('overviewToRows', () => {
  it('should produce the correct number of rows', () => {
    const overview = createMockOverview();
    const rows = overviewToRows(overview, 'proxmox-host');

    // 1 cluster + 2 nodes + 1 VM + 1 container + 1 storage = 6
    expect(rows).toHaveLength(6);
  });

  it('should produce a cluster row with correct fields', () => {
    const overview = createMockOverview();
    const rows = overviewToRows(overview, 'proxmox-host');
    const cluster = rows.find(r => r.entity_type === 'cluster')!;

    expect(cluster).toBeDefined();
    expect(cluster.host).toBe('proxmox-host');
    expect(cluster.entity_id).toBe('test-cluster');
    expect(cluster.entity_name).toBe('test-cluster');
    expect(cluster.status).toBe('quorate');
    expect(cluster.cluster_version).toBe(5);
    expect(cluster.cpu).toBe(2);
    expect(cluster.max_cpu).toBe(12);
    expect(cluster.mem).toBe(4_000_000_000);
    expect(cluster.max_mem).toBe(24_000_000_000);
    expect(cluster.node).toBeNull();
    expect(cluster.vmid).toBeNull();
  });

  it('should produce a no-quorum status when not quorate', () => {
    const overview = createMockOverview();
    overview.quorate = false;
    const rows = overviewToRows(overview, 'host');
    const cluster = rows.find(r => r.entity_type === 'cluster')!;

    expect(cluster.status).toBe('no-quorum');
  });

  it('should produce node rows with correct cpu calculation', () => {
    const overview = createMockOverview();
    const rows = overviewToRows(overview, 'host');
    const nodeRows = rows.filter(r => r.entity_type === 'node');

    expect(nodeRows).toHaveLength(2);

    const pve1 = nodeRows.find(r => r.entity_id === 'pve1')!;
    expect(pve1.node).toBe('pve1');
    expect(pve1.status).toBe('online');
    // cpu field = node.cpu * node.maxcpu = 0.25 * 8 = 2
    expect(pve1.cpu).toBe(2);
    expect(pve1.max_cpu).toBe(8);
    expect(pve1.mem).toBe(4_000_000_000);
    expect(pve1.uptime).toBe(86400);

    const pve2 = nodeRows.find(r => r.entity_id === 'pve2')!;
    expect(pve2.status).toBe('offline');
    expect(pve2.cpu).toBe(0);
  });

  it('should produce VM rows with vmid and network fields', () => {
    const overview = createMockOverview();
    const rows = overviewToRows(overview, 'host');
    const vmRows = rows.filter(r => r.entity_type === 'qemu');

    expect(vmRows).toHaveLength(1);
    const vm = vmRows[0];
    expect(vm.vmid).toBe(100);
    expect(vm.entity_id).toBe('100');
    expect(vm.entity_name).toBe('ubuntu-vm');
    expect(vm.netin).toBe(1_000_000);
    expect(vm.netout).toBe(500_000);
    expect(vm.node).toBe('pve1');
    expect(vm.storage_type).toBeNull();
  });

  it('should produce container rows', () => {
    const overview = createMockOverview();
    const rows = overviewToRows(overview, 'host');
    const ctRows = rows.filter(r => r.entity_type === 'lxc');

    expect(ctRows).toHaveLength(1);
    const ct = ctRows[0];
    expect(ct.vmid).toBe(200);
    expect(ct.entity_name).toBe('nginx-ct');
    expect(ct.status).toBe('running');
  });

  it('should produce storage rows with unique entity_id', () => {
    const overview = createMockOverview();
    const rows = overviewToRows(overview, 'host');
    const storageRows = rows.filter(r => r.entity_type === 'storage');

    expect(storageRows).toHaveLength(1);
    const storage = storageRows[0];
    expect(storage.entity_id).toBe('pve1/local');
    expect(storage.entity_name).toBe('local');
    expect(storage.storage_type).toBe('dir');
    expect(storage.storage_content).toBe('rootdir,images');
    expect(storage.storage_shared).toBe(false);
    expect(storage.disk).toBe(20_000_000_000);
    expect(storage.max_disk).toBe(100_000_000_000);
    expect(storage.storage_avail).toBe(80_000_000_000);
    expect(storage.status).toBe('active');
    expect(storage.cpu).toBeNull();
  });

  it('should handle inactive storage', () => {
    const overview = createMockOverview();
    overview.storages[0].active = 0;
    const rows = overviewToRows(overview, 'host');
    const storage = rows.find(r => r.entity_type === 'storage')!;

    expect(storage.status).toBe('inactive');
  });

  it('should handle shared storage', () => {
    const overview = createMockOverview();
    overview.storages[0].shared = 1;
    const rows = overviewToRows(overview, 'host');
    const storage = rows.find(r => r.entity_type === 'storage')!;

    expect(storage.storage_shared).toBe(true);
  });

  it('should handle empty overview with no VMs/containers/storages', () => {
    const overview = createMockOverview();
    overview.vms = [];
    overview.containers = [];
    overview.storages = [];
    overview.nodes = [];
    const rows = overviewToRows(overview, 'host');

    // Only cluster row remains
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_type).toBe('cluster');
  });

  it('should set all times to the same timestamp', () => {
    const overview = createMockOverview();
    const rows = overviewToRows(overview, 'host');

    const times = rows.map(r => new Date(r.time).getTime());
    const unique = new Set(times);
    expect(unique.size).toBe(1);
  });
});
