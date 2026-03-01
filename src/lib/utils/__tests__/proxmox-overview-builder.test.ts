import { describe, it, expect } from 'bun:test';
import { buildProxmoxOverview } from '../proxmox-overview-builder';
import { overviewToRows } from '../proxmox-overview-converter';
import type { ProxmoxClusterOverview, ProxmoxStatsRow } from '@/types/proxmox';

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
      totalCpu: 8,
      usedCpu: 2,
      totalMemory: 16_000_000_000,
      usedMemory: 4_000_000_000,
      totalDisk: 500_000_000_000,
      usedDisk: 50_000_000_000,
      runningVMs: 1,
      stoppedVMs: 0,
      runningContainers: 1,
      stoppedContainers: 0,
    },
  };
}

function rowsToLatestMap(rows: ProxmoxStatsRow[]): Map<string, ProxmoxStatsRow> {
  const map = new Map<string, ProxmoxStatsRow>();
  for (const row of rows) {
    const key = `${row.entity_type}/${row.entity_id}`;
    map.set(key, row);
  }
  return map;
}

describe('buildProxmoxOverview', () => {
  it('should return null for an empty map', () => {
    const result = buildProxmoxOverview(new Map());
    expect(result).toBeNull();
  });

  it('should reconstruct cluster metadata from rows', () => {
    const overview = createMockOverview();
    const rows = overviewToRows(overview, 'host');
    const latest = rowsToLatestMap(rows);

    const rebuilt = buildProxmoxOverview(latest)!;
    expect(rebuilt).not.toBeNull();
    expect(rebuilt.clusterName).toBe('test-cluster');
    expect(rebuilt.quorate).toBe(true);
    expect(rebuilt.version).toBe(5);
  });

  it('should reconstruct nodes with correct cpu fraction', () => {
    const overview = createMockOverview();
    const rows = overviewToRows(overview, 'host');
    const latest = rowsToLatestMap(rows);

    const rebuilt = buildProxmoxOverview(latest)!;
    expect(rebuilt.nodes).toHaveLength(1);

    const node = rebuilt.nodes[0];
    expect(node.node).toBe('pve1');
    expect(node.status).toBe('online');
    expect(node.maxcpu).toBe(8);
    // cpu fraction: stored as cpu=2, max_cpu=8 → reconstructed as 2/8 = 0.25
    expect(node.cpu).toBe(0.25);
    expect(node.mem).toBe(4_000_000_000);
    expect(node.maxmem).toBe(16_000_000_000);
    expect(node.uptime).toBe(86400);
  });

  it('should reconstruct VMs', () => {
    const overview = createMockOverview();
    const rows = overviewToRows(overview, 'host');
    const latest = rowsToLatestMap(rows);

    const rebuilt = buildProxmoxOverview(latest)!;
    expect(rebuilt.vms).toHaveLength(1);

    const vm = rebuilt.vms[0];
    expect(vm.vmid).toBe(100);
    expect(vm.name).toBe('ubuntu-vm');
    expect(vm.status).toBe('running');
    expect(vm.cpu).toBe(0.5);
    expect(vm.cpus).toBe(4);
    expect(vm.netin).toBe(1_000_000);
    expect(vm.node).toBe('pve1');
  });

  it('should reconstruct containers', () => {
    const overview = createMockOverview();
    const rows = overviewToRows(overview, 'host');
    const latest = rowsToLatestMap(rows);

    const rebuilt = buildProxmoxOverview(latest)!;
    expect(rebuilt.containers).toHaveLength(1);

    const ct = rebuilt.containers[0];
    expect(ct.vmid).toBe(200);
    expect(ct.name).toBe('nginx-ct');
    expect(ct.status).toBe('running');
    expect(ct.node).toBe('pve1');
  });

  it('should reconstruct storages', () => {
    const overview = createMockOverview();
    const rows = overviewToRows(overview, 'host');
    const latest = rowsToLatestMap(rows);

    const rebuilt = buildProxmoxOverview(latest)!;
    expect(rebuilt.storages).toHaveLength(1);

    const storage = rebuilt.storages[0];
    expect(storage.storage).toBe('local');
    expect(storage.type).toBe('dir');
    expect(storage.content).toBe('rootdir,images');
    expect(storage.shared).toBe(0);
    expect(storage.active).toBe(1);
    expect(storage.used).toBe(20_000_000_000);
    expect(storage.avail).toBe(80_000_000_000);
    expect(storage.total).toBe(100_000_000_000);
    expect(storage.node).toBe('pve1');
  });

  it('should compute totals from node rows', () => {
    const overview = createMockOverview();
    const rows = overviewToRows(overview, 'host');
    const latest = rowsToLatestMap(rows);

    const rebuilt = buildProxmoxOverview(latest)!;
    expect(rebuilt.totals.totalCpu).toBe(8);
    // usedCpu = node.cpu * node.maxcpu = 0.25 * 8 = 2
    expect(rebuilt.totals.usedCpu).toBe(2);
    expect(rebuilt.totals.totalMemory).toBe(16_000_000_000);
    expect(rebuilt.totals.usedMemory).toBe(4_000_000_000);
    expect(rebuilt.totals.totalDisk).toBe(500_000_000_000);
    expect(rebuilt.totals.usedDisk).toBe(50_000_000_000);
    expect(rebuilt.totals.runningVMs).toBe(1);
    expect(rebuilt.totals.stoppedVMs).toBe(0);
    expect(rebuilt.totals.runningContainers).toBe(1);
    expect(rebuilt.totals.stoppedContainers).toBe(0);
  });

  it('should handle no-quorum cluster', () => {
    const overview = createMockOverview();
    overview.quorate = false;
    const rows = overviewToRows(overview, 'host');
    const latest = rowsToLatestMap(rows);

    const rebuilt = buildProxmoxOverview(latest)!;
    expect(rebuilt.quorate).toBe(false);
  });

  it('should count stopped VMs and containers', () => {
    const overview = createMockOverview();
    overview.vms[0].status = 'stopped';
    overview.containers[0].status = 'stopped';
    const rows = overviewToRows(overview, 'host');
    const latest = rowsToLatestMap(rows);

    const rebuilt = buildProxmoxOverview(latest)!;
    expect(rebuilt.totals.runningVMs).toBe(0);
    expect(rebuilt.totals.stoppedVMs).toBe(1);
    expect(rebuilt.totals.runningContainers).toBe(0);
    expect(rebuilt.totals.stoppedContainers).toBe(1);
  });

  it('should handle inactive storage', () => {
    const overview = createMockOverview();
    overview.storages[0].active = 0;
    const rows = overviewToRows(overview, 'host');
    const latest = rowsToLatestMap(rows);

    const rebuilt = buildProxmoxOverview(latest)!;
    expect(rebuilt.storages[0].active).toBe(0);
  });

  it('should handle shared storage', () => {
    const overview = createMockOverview();
    overview.storages[0].shared = 1;
    const rows = overviewToRows(overview, 'host');
    const latest = rowsToLatestMap(rows);

    const rebuilt = buildProxmoxOverview(latest)!;
    expect(rebuilt.storages[0].shared).toBe(1);
  });

  it('should return overview with Standalone name when no cluster row', () => {
    // Only a node row, no cluster row
    const nodeRow: ProxmoxStatsRow = {
      time: new Date(),
      host: 'host',
      entity_type: 'node',
      node: 'pve1',
      entity_id: 'pve1',
      entity_name: 'pve1',
      status: 'online',
      cpu: 1,
      max_cpu: 4,
      mem: 1_000_000_000,
      max_mem: 8_000_000_000,
      disk: 10_000_000_000,
      max_disk: 100_000_000_000,
      uptime: 3600,
      vmid: null,
      netin: null,
      netout: null,
      storage_type: null,
      storage_content: null,
      storage_avail: null,
      storage_shared: null,
      cluster_version: null,
    };

    const map = new Map([['node/pve1', nodeRow]]);
    const rebuilt = buildProxmoxOverview(map)!;
    expect(rebuilt.clusterName).toBe('Standalone');
    expect(rebuilt.quorate).toBe(false);
    expect(rebuilt.version).toBe(0);
  });

  it('should handle node with zero max_cpu (avoid division by zero)', () => {
    const nodeRow: ProxmoxStatsRow = {
      time: new Date(),
      host: 'host',
      entity_type: 'node',
      node: 'pve1',
      entity_id: 'pve1',
      entity_name: 'pve1',
      status: 'online',
      cpu: 0,
      max_cpu: 0,
      mem: 0,
      max_mem: 0,
      disk: 0,
      max_disk: 0,
      uptime: 0,
      vmid: null,
      netin: null,
      netout: null,
      storage_type: null,
      storage_content: null,
      storage_avail: null,
      storage_shared: null,
      cluster_version: null,
    };

    const map = new Map([['node/pve1', nodeRow]]);
    const rebuilt = buildProxmoxOverview(map)!;
    expect(rebuilt.nodes[0].cpu).toBe(0);
  });

  it('should handle storage with zero max_disk', () => {
    const storageRow: ProxmoxStatsRow = {
      time: new Date(),
      host: 'host',
      entity_type: 'storage',
      node: 'pve1',
      entity_id: 'pve1/local',
      entity_name: 'local',
      status: 'active',
      cpu: null,
      max_cpu: null,
      mem: null,
      max_mem: null,
      disk: 0,
      max_disk: 0,
      uptime: null,
      vmid: null,
      netin: null,
      netout: null,
      storage_type: 'dir',
      storage_content: 'rootdir',
      storage_avail: 0,
      storage_shared: false,
      cluster_version: null,
    };

    const clusterRow: ProxmoxStatsRow = {
      time: new Date(),
      host: 'host',
      entity_type: 'cluster',
      node: null,
      entity_id: 'cluster',
      entity_name: 'cluster',
      status: 'quorate',
      cpu: 0,
      max_cpu: 0,
      mem: 0,
      max_mem: 0,
      disk: 0,
      max_disk: 0,
      uptime: null,
      vmid: null,
      netin: null,
      netout: null,
      storage_type: null,
      storage_content: null,
      storage_avail: null,
      storage_shared: null,
      cluster_version: 1,
    };

    const map = new Map([
      ['cluster/cluster', clusterRow],
      ['storage/pve1/local', storageRow],
    ]);
    const rebuilt = buildProxmoxOverview(map)!;
    expect(rebuilt.storages[0].used_fraction).toBe(0);
  });

  it('should handle rows with null fields gracefully', () => {
    const vmRow: ProxmoxStatsRow = {
      time: new Date(),
      host: 'host',
      entity_type: 'qemu',
      node: null,
      entity_id: '100',
      entity_name: null,
      status: null,
      cpu: null,
      max_cpu: null,
      mem: null,
      max_mem: null,
      disk: null,
      max_disk: null,
      uptime: null,
      vmid: null,
      netin: null,
      netout: null,
      storage_type: null,
      storage_content: null,
      storage_avail: null,
      storage_shared: null,
      cluster_version: null,
    };

    const clusterRow: ProxmoxStatsRow = {
      time: new Date(),
      host: 'host',
      entity_type: 'cluster',
      node: null,
      entity_id: 'c',
      entity_name: 'c',
      status: 'quorate',
      cpu: 0,
      max_cpu: 0,
      mem: 0,
      max_mem: 0,
      disk: 0,
      max_disk: 0,
      uptime: null,
      vmid: null,
      netin: null,
      netout: null,
      storage_type: null,
      storage_content: null,
      storage_avail: null,
      storage_shared: null,
      cluster_version: 1,
    };

    const map = new Map([
      ['cluster/c', clusterRow],
      ['qemu/100', vmRow],
    ]);
    const rebuilt = buildProxmoxOverview(map)!;
    expect(rebuilt.vms).toHaveLength(1);
    expect(rebuilt.vms[0].vmid).toBe(0);
    expect(rebuilt.vms[0].name).toBe('');
    expect(rebuilt.vms[0].node).toBe('');
  });
});
