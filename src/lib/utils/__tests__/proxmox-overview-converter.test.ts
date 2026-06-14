import { describe, it, expect } from 'bun:test';
import { snapshotToRows } from '../proxmox-overview-converter';
import type { ProxmoxClusterSnapshot } from '@/types/proxmox';

function createMockSnapshot(): ProxmoxClusterSnapshot {
  return {
    clusterName: 'test-cluster',
    quorate: true,
    version: 5,
    resources: [
      {
        id: 'node/pve1',
        type: 'node',
        node: 'pve1',
        status: 'online',
        cpu: 0.25,
        maxcpu: 8,
        mem: 4_000_000_000,
        maxmem: 16_000_000_000,
        disk: 50_000_000_000,
        maxdisk: 500_000_000_000,
        uptime: 86400,
      },
      {
        id: 'node/pve2',
        type: 'node',
        node: 'pve2',
        status: 'offline',
        cpu: 0,
        maxcpu: 4,
        mem: 0,
        maxmem: 8_000_000_000,
        disk: 0,
        maxdisk: 250_000_000_000,
        uptime: 0,
      },
      {
        id: 'qemu/100',
        type: 'qemu',
        node: 'pve1',
        status: 'running',
        vmid: 100,
        name: 'ubuntu-vm',
        cpu: 0.5,
        maxcpu: 4,
        mem: 2_000_000_000,
        maxmem: 4_000_000_000,
        disk: 10_000_000_000,
        maxdisk: 50_000_000_000,
        uptime: 3600,
        netin: 1_000_000,
        netout: 500_000,
        diskread: 100,
        diskwrite: 200,
      },
      {
        id: 'lxc/200',
        type: 'lxc',
        node: 'pve1',
        status: 'running',
        vmid: 200,
        name: 'nginx-ct',
        cpu: 0.1,
        maxcpu: 2,
        mem: 512_000_000,
        maxmem: 1_000_000_000,
        disk: 1_000_000_000,
        maxdisk: 5_000_000_000,
        uptime: 7200,
        netin: 200_000,
        netout: 100_000,
        diskread: 50,
        diskwrite: 25,
      },
      {
        id: 'storage/pve1/local',
        type: 'storage',
        node: 'pve1',
        status: 'available',
        storage: 'local',
        plugintype: 'dir',
        content: 'rootdir,images',
        shared: 0,
        disk: 20_000_000_000,
        maxdisk: 100_000_000_000,
      },
    ],
  };
}

describe('snapshotToRows', () => {
  it('should produce the correct number of rows', () => {
    const snapshot = createMockSnapshot();
    const rows = snapshotToRows(snapshot, 'proxmox-host');

    // 1 cluster + 2 nodes + 1 VM + 1 container + 1 storage = 6
    expect(rows).toHaveLength(6);
  });

  it('should produce a cluster row with totals computed from node resources', () => {
    const snapshot = createMockSnapshot();
    const rows = snapshotToRows(snapshot, 'proxmox-host');
    const cluster = rows.find(r => r.entity_type === 'cluster')!;

    expect(cluster).toBeDefined();
    expect(cluster.host).toBe('proxmox-host');
    expect(cluster.entity_id).toBe('test-cluster');
    expect(cluster.entity_name).toBe('test-cluster');
    expect(cluster.status).toBe('quorate');
    expect(cluster.cluster_version).toBe(5);
    // usedCpu = 0.25 * 8 + 0 * 4 = 2
    expect(cluster.cpu).toBe(2);
    // totalCpu = 8 + 4 = 12
    expect(cluster.max_cpu).toBe(12);
    expect(cluster.mem).toBe(4_000_000_000);
    expect(cluster.max_mem).toBe(24_000_000_000);
    expect(cluster.disk).toBe(50_000_000_000);
    expect(cluster.max_disk).toBe(750_000_000_000);
    expect(cluster.node).toBeNull();
    expect(cluster.vmid).toBeNull();
  });

  it('should produce a no-quorum status when not quorate', () => {
    const snapshot = createMockSnapshot();
    snapshot.quorate = false;
    const rows = snapshotToRows(snapshot, 'host');
    const cluster = rows.find(r => r.entity_type === 'cluster')!;

    expect(cluster.status).toBe('no-quorum');
  });

  it('should produce node rows with correct cpu calculation', () => {
    const snapshot = createMockSnapshot();
    const rows = snapshotToRows(snapshot, 'host');
    const nodeRows = rows.filter(r => r.entity_type === 'node');

    expect(nodeRows).toHaveLength(2);

    const pve1 = nodeRows.find(r => r.entity_id === 'pve1')!;
    expect(pve1.node).toBe('pve1');
    expect(pve1.status).toBe('online');
    // cpu field = fraction * maxcpu = 0.25 * 8 = 2
    expect(pve1.cpu).toBe(2);
    expect(pve1.max_cpu).toBe(8);
    expect(pve1.mem).toBe(4_000_000_000);
    expect(pve1.uptime).toBe(86400);

    const pve2 = nodeRows.find(r => r.entity_id === 'pve2')!;
    expect(pve2.status).toBe('offline');
    expect(pve2.cpu).toBe(0);
  });

  it('should produce VM rows with vmid and network fields', () => {
    const snapshot = createMockSnapshot();
    const rows = snapshotToRows(snapshot, 'host');
    const vmRows = rows.filter(r => r.entity_type === 'qemu');

    expect(vmRows).toHaveLength(1);
    const vm = vmRows[0];
    expect(vm.vmid).toBe(100);
    expect(vm.entity_id).toBe('100');
    expect(vm.entity_name).toBe('ubuntu-vm');
    expect(vm.cpu).toBe(0.5);
    expect(vm.max_cpu).toBe(4);
    expect(vm.netin).toBe(1_000_000);
    expect(vm.netout).toBe(500_000);
    expect(vm.node).toBe('pve1');
    expect(vm.storage_type).toBeNull();
  });

  it('should produce container rows', () => {
    const snapshot = createMockSnapshot();
    const rows = snapshotToRows(snapshot, 'host');
    const ctRows = rows.filter(r => r.entity_type === 'lxc');

    expect(ctRows).toHaveLength(1);
    const ct = ctRows[0];
    expect(ct.vmid).toBe(200);
    expect(ct.entity_name).toBe('nginx-ct');
    expect(ct.status).toBe('running');
  });

  it('should filter out template guests', () => {
    const snapshot = createMockSnapshot();
    snapshot.resources.push(
      { id: 'qemu/900', type: 'qemu', node: 'pve1', status: 'stopped', vmid: 900, name: 'vm-template', template: 1 },
      { id: 'lxc/901', type: 'lxc', node: 'pve1', status: 'stopped', vmid: 901, name: 'ct-template', template: 1 },
    );
    const rows = snapshotToRows(snapshot, 'host');

    expect(rows.filter(r => r.entity_type === 'qemu')).toHaveLength(1);
    expect(rows.filter(r => r.entity_type === 'lxc')).toHaveLength(1);
  });

  it('should ignore sdn and pool resources', () => {
    const snapshot = createMockSnapshot();
    snapshot.resources.push(
      { id: 'sdn/pve1/zone1', type: 'sdn', node: 'pve1', status: 'ok' },
      { id: '/pool/prod', type: 'pool', status: 'ok', pool: 'prod' },
    );
    const rows = snapshotToRows(snapshot, 'host');

    expect(rows).toHaveLength(6);
  });

  it('should produce storage rows with unique entity_id', () => {
    const snapshot = createMockSnapshot();
    const rows = snapshotToRows(snapshot, 'host');
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
    // avail derived from maxdisk - disk
    expect(storage.storage_avail).toBe(80_000_000_000);
    expect(storage.status).toBe('active');
    expect(storage.cpu).toBeNull();
  });

  it('should map unavailable storage to inactive status', () => {
    const snapshot = createMockSnapshot();
    snapshot.resources.find(r => r.type === 'storage')!.status = 'unavailable';
    const rows = snapshotToRows(snapshot, 'host');
    const storage = rows.find(r => r.entity_type === 'storage')!;

    expect(storage.status).toBe('inactive');
  });

  it('should handle shared storage', () => {
    const snapshot = createMockSnapshot();
    snapshot.resources.find(r => r.type === 'storage')!.shared = 1;
    const rows = snapshotToRows(snapshot, 'host');
    const storage = rows.find(r => r.entity_type === 'storage')!;

    expect(storage.storage_shared).toBe(true);
  });

  it('should default missing numeric fields to 0', () => {
    const snapshot: ProxmoxClusterSnapshot = {
      clusterName: 'c',
      quorate: true,
      version: 1,
      resources: [
        { id: 'node/pve1', type: 'node', node: 'pve1', status: 'offline' },
        { id: 'qemu/100', type: 'qemu', node: 'pve1', status: 'unknown', vmid: 100, name: 'vm1' },
        { id: 'storage/pve1/local', type: 'storage', node: 'pve1', status: 'unavailable', storage: 'local' },
      ],
    };
    const rows = snapshotToRows(snapshot, 'host');

    const node = rows.find(r => r.entity_type === 'node')!;
    expect(node.cpu).toBe(0);
    expect(node.max_cpu).toBe(0);
    expect(node.mem).toBe(0);
    expect(node.uptime).toBe(0);

    const vm = rows.find(r => r.entity_type === 'qemu')!;
    expect(vm.cpu).toBe(0);
    expect(vm.netin).toBe(0);
    expect(vm.netout).toBe(0);

    const storage = rows.find(r => r.entity_type === 'storage')!;
    expect(storage.disk).toBe(0);
    expect(storage.max_disk).toBe(0);
    expect(storage.storage_avail).toBe(0);
  });

  it('should handle empty resources with only a cluster row', () => {
    const snapshot = createMockSnapshot();
    snapshot.resources = [];
    const rows = snapshotToRows(snapshot, 'host');

    expect(rows).toHaveLength(1);
    expect(rows[0].entity_type).toBe('cluster');
  });

  it('should set all times to the same timestamp', () => {
    const snapshot = createMockSnapshot();
    const rows = snapshotToRows(snapshot, 'host');

    const times = rows.map(r => new Date(r.time).getTime());
    const unique = new Set(times);
    expect(unique.size).toBe(1);
  });
});
