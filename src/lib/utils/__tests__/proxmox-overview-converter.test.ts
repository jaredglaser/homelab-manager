import { describe, it, expect } from 'bun:test';
import { ProxmoxRateTracker, snapshotToRows } from '../proxmox-overview-converter';
import type { ProxmoxClusterSnapshot, ProxmoxResource } from '@/types/proxmox';

function createMockSnapshot(): ProxmoxClusterSnapshot {
  return {
    clusterName: 'test-cluster',
    quorate: true,
    version: 5,
    sampledAtMs: 0,
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
      { id: '/pool/prod', type: 'pool', status: 'ok' },
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
      sampledAtMs: 0,
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

describe('ProxmoxRateTracker', () => {
  interface Sample {
    uptime: number;
    netin: number;
    netout: number;
    diskread: number;
    diskwrite: number;
    status?: string;
  }

  function guest(sample: Sample, vmid = 100): ProxmoxResource {
    return { id: `qemu/${vmid}`, type: 'qemu', node: 'pve1', vmid, status: sample.status ?? 'running', ...sample };
  }

  const start: Sample = { uptime: 1000, netin: 10_000, netout: 20_000, diskread: 30_000, diskwrite: 40_000 };

  function advance(prev: Sample, seconds: number, perSec: [number, number, number, number]): Sample {
    return {
      uptime: prev.uptime + seconds,
      netin: prev.netin + perSec[0] * seconds,
      netout: prev.netout + perSec[1] * seconds,
      diskread: prev.diskread + perSec[2] * seconds,
      diskwrite: prev.diskwrite + perSec[3] * seconds,
    };
  }

  const allNull = { netInBytesPerSec: null, netOutBytesPerSec: null, diskReadBytesPerSec: null, diskWriteBytesPerSec: null };

  it('gives the first point after start no rate, never 0', () => {
    const tracker = new ProxmoxRateTracker();
    expect(tracker.rates(guest(start), 'qemu', 0)).toEqual(allNull);
  });

  it('divides each counter delta by the seconds between the two samples', () => {
    const tracker = new ProxmoxRateTracker();
    tracker.rates(guest(start), 'qemu', 0);
    const next = advance(start, 10, [100, 200, 300, 400]);
    expect(tracker.rates(guest(next), 'qemu', 10_000)).toEqual({
      netInBytesPerSec: 100,
      netOutBytesPerSec: 200,
      diskReadBytesPerSec: 300,
      diskWriteBytesPerSec: 400,
    });
  });

  it('stays correct when the poll interval switches between 10 and 1 seconds', () => {
    const tracker = new ProxmoxRateTracker();
    let sample = start;
    tracker.rates(guest(sample), 'qemu', 0);
    sample = advance(sample, 10, [500, 500, 500, 500]);
    expect(tracker.rates(guest(sample), 'qemu', 10_000).netInBytesPerSec).toBe(500);
    sample = advance(sample, 1, [500, 500, 500, 500]);
    expect(tracker.rates(guest(sample), 'qemu', 11_000).netInBytesPerSec).toBe(500);
    sample = advance(sample, 10, [500, 500, 500, 500]);
    expect(tracker.rates(guest(sample), 'qemu', 21_000).netInBytesPerSec).toBe(500);
  });

  it('uses the time Proxmox sampled at, so a slow or late poll does not skew the rate', () => {
    const tracker = new ProxmoxRateTracker();
    tracker.rates(guest(start), 'qemu', 0);
    const next = advance(start, 10, [100, 100, 100, 100]);
    expect(tracker.rates(guest(next), 'qemu', 27_000).netInBytesPerSec).toBe(100);
  });

  it('falls back to the worker clock when uptime did not move but the counters did', () => {
    const tracker = new ProxmoxRateTracker();
    tracker.rates(guest(start), 'qemu', 0);
    const next = { ...start, netin: start.netin + 4000 };
    expect(tracker.rates(guest(next), 'qemu', 2_000).netInBytesPerSec).toBe(2000);
  });

  it('repeats the last rates for a poll that sees the same Proxmox sample again, instead of 0', () => {
    const tracker = new ProxmoxRateTracker();
    tracker.rates(guest(start), 'qemu', 0);
    const next = advance(start, 10, [100, 100, 100, 100]);
    const first = tracker.rates(guest(next), 'qemu', 10_000);
    expect(tracker.rates(guest(next), 'qemu', 11_000)).toBe(first);
    const later = advance(next, 10, [300, 300, 300, 300]);
    expect(tracker.rates(guest(later), 'qemu', 20_000).netInBytesPerSec).toBe(300);
  });

  it('gives an idle guest 0, once its uptime moves on with the counters unchanged', () => {
    const tracker = new ProxmoxRateTracker();
    tracker.rates(guest(start), 'qemu', 0);
    expect(tracker.rates(guest({ ...start, uptime: start.uptime + 10 }), 'qemu', 10_000)).toEqual({
      netInBytesPerSec: 0,
      netOutBytesPerSec: 0,
      diskReadBytesPerSec: 0,
      diskWriteBytesPerSec: 0,
    });
  });

  it('blanks the one point where a guest restarted and its counters reset, never negative', () => {
    const tracker = new ProxmoxRateTracker();
    tracker.rates(guest(advance(start, 500, [100, 100, 100, 100])), 'qemu', 0);
    const restarted: Sample = { uptime: 5, netin: 300, netout: 300, diskread: 300, diskwrite: 300 };
    expect(tracker.rates(guest(restarted), 'qemu', 10_000)).toEqual(allNull);
    const after = advance(restarted, 10, [50, 50, 50, 50]);
    expect(tracker.rates(guest(after), 'qemu', 20_000).netInBytesPerSec).toBe(50);
  });

  it('blanks only the rate whose counter fell just below its previous value, while uptime moved on', () => {
    const tracker = new ProxmoxRateTracker();
    tracker.rates(guest(start), 'qemu', 0);
    const next = { ...advance(start, 10, [100, 100, 100, 100]), diskwrite: start.diskwrite - 1 };
    expect(tracker.rates(guest(next), 'qemu', 10_000)).toEqual({
      netInBytesPerSec: 100,
      netOutBytesPerSec: 100,
      diskReadBytesPerSec: 100,
      diskWriteBytesPerSec: null,
    });
  });

  it('keeps the network rates when a disk is unplugged and its counters restart', () => {
    const tracker = new ProxmoxRateTracker();
    tracker.rates(guest(start), 'qemu', 0);
    const next = { ...advance(start, 10, [50, 60, 0, 0]), diskread: 0, diskwrite: 0 };
    expect(tracker.rates(guest(next), 'qemu', 10_000)).toEqual({
      netInBytesPerSec: 50,
      netOutBytesPerSec: 60,
      diskReadBytesPerSec: null,
      diskWriteBytesPerSec: null,
    });
  });

  it('blanks all four when uptime went backwards, even if every counter grew', () => {
    const tracker = new ProxmoxRateTracker();
    tracker.rates(guest(start), 'qemu', 0);
    const next = { ...advance(start, 10, [100, 100, 100, 100]), uptime: start.uptime - 1 };
    expect(tracker.rates(guest(next), 'qemu', 10_000)).toEqual(allNull);
  });

  it('stops repeating a sample Proxmox has not refreshed for over a minute', () => {
    const tracker = new ProxmoxRateTracker();
    tracker.rates(guest(start), 'qemu', 0);
    const next = advance(start, 10, [100, 100, 100, 100]);
    expect(tracker.rates(guest(next), 'qemu', 10_000).netInBytesPerSec).toBe(100);
    expect(tracker.rates(guest(next), 'qemu', 69_000).netInBytesPerSec).toBe(100);
    expect(tracker.rates(guest(next), 'qemu', 71_000)).toEqual(allNull);
    const resumed = advance(next, 70, [20, 20, 20, 20]);
    expect(tracker.rates(guest(resumed), 'qemu', 80_000).netInBytesPerSec).toBe(20);
  });

  it.each(['stopped', 'paused'])('blanks a %s guest even while its uptime and counters keep moving', (status) => {
    const tracker = new ProxmoxRateTracker();
    tracker.rates(guest(start), 'qemu', 0);
    let sample = start;
    for (let poll = 1; poll <= 3; poll++) {
      sample = advance(sample, 10, [100, 200, 300, 400]);
      expect(tracker.rates(guest({ ...sample, status }), 'qemu', poll * 10_000)).toEqual(allNull);
    }
  });

  it('starts a guest blank when it runs again after being stopped', () => {
    const tracker = new ProxmoxRateTracker();
    tracker.rates(guest(start), 'qemu', 0);
    const stopped = advance(start, 10, [100, 100, 100, 100]);
    tracker.rates(guest({ ...stopped, status: 'stopped' }), 'qemu', 10_000);
    expect(tracker.rates(guest(advance(stopped, 10, [100, 100, 100, 100])), 'qemu', 20_000)).toEqual(allNull);
  });

  it('blanks a guest Proxmox reports without counters', () => {
    const tracker = new ProxmoxRateTracker();
    const bare: ProxmoxResource = { id: 'qemu/100', type: 'qemu', vmid: 100, status: 'running', uptime: 10 };
    tracker.rates(bare, 'qemu', 0);
    expect(tracker.rates({ ...bare, uptime: 20 }, 'qemu', 10_000)).toEqual(allNull);
  });

  it('gives two polls with the same timestamp and new counters no rate rather than a division by zero', () => {
    const tracker = new ProxmoxRateTracker();
    tracker.rates(guest(start), 'qemu', 5_000);
    expect(tracker.rates(guest({ ...start, netin: start.netin + 10 }), 'qemu', 5_000)).toEqual(allNull);
  });

  it('keeps a guest that migrates to another node on the same series', () => {
    const tracker = new ProxmoxRateTracker();
    tracker.rates(guest(start), 'qemu', 0);
    const moved = { ...guest(advance(start, 10, [100, 100, 100, 100])), node: 'pve2' };
    expect(tracker.rates(moved, 'qemu', 10_000).netInBytesPerSec).toBe(100);
  });

  it('keeps a VM and a container with the same vmid apart', () => {
    const tracker = new ProxmoxRateTracker();
    tracker.rates(guest(start), 'qemu', 0);
    expect(tracker.rates({ ...guest(advance(start, 10, [1, 1, 1, 1])), type: 'lxc' }, 'lxc', 10_000)).toEqual(allNull);
  });

  it('writes the rates onto the guest rows across polls of one connection', () => {
    const tracker = new ProxmoxRateTracker();
    const snapshot = (sample: Sample, sampledAtMs: number): ProxmoxClusterSnapshot => ({
      clusterName: 'c', quorate: true, version: 1, sampledAtMs, resources: [guest(sample)],
    });
    const first = snapshotToRows(snapshot(start, 0), 'pve.lan', tracker).find((r) => r.entity_type === 'qemu')!;
    expect(first.net_in_bytes_per_sec).toBeNull();
    expect(first.disk_write_bytes_per_sec).toBeNull();
    const next = advance(start, 10, [100, 200, 300, 400]);
    const second = snapshotToRows(snapshot(next, 10_000), 'pve.lan', tracker).find((r) => r.entity_type === 'qemu')!;
    expect(second).toMatchObject({
      net_in_bytes_per_sec: 100,
      net_out_bytes_per_sec: 200,
      disk_read_bytes_per_sec: 300,
      disk_write_bytes_per_sec: 400,
      netin: next.netin,
    });
  });

  it('forgets a guest that left the snapshot, so it starts blank when it returns', () => {
    const tracker = new ProxmoxRateTracker();
    const snapshot = (resources: ProxmoxResource[], sampledAtMs: number): ProxmoxClusterSnapshot => ({
      clusterName: 'c', quorate: true, version: 1, sampledAtMs, resources,
    });
    snapshotToRows(snapshot([guest(start)], 0), 'pve.lan', tracker);
    snapshotToRows(snapshot([], 10_000), 'pve.lan', tracker);
    const back = snapshotToRows(snapshot([guest(advance(start, 20, [5, 5, 5, 5]))], 20_000), 'pve.lan', tracker);
    expect(back.find((r) => r.entity_type === 'qemu')!.net_in_bytes_per_sec).toBeNull();
  });

  it('gives node, storage and cluster rows no rates', () => {
    const rows = snapshotToRows(createMockSnapshot(), 'pve.lan');
    for (const row of rows.filter((r) => r.entity_type !== 'qemu' && r.entity_type !== 'lxc')) {
      expect(row.net_in_bytes_per_sec).toBeNull();
      expect(row.disk_write_bytes_per_sec).toBeNull();
    }
  });
});
