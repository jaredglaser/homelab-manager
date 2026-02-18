import { describe, it, expect, spyOn } from 'bun:test';
import { buildHierarchy, rowToZFSStats } from '../zfs-hierarchy-builder';
import type { ZFSIOStatWithRates, ZFSStatsRow } from '@/types/zfs';

describe('buildHierarchy', () => {
  // Helper to create mock ZFS stats
  function createMockStat(name: string, indent: number): ZFSIOStatWithRates {
    return {
      name,
      indent,
      capacity: { alloc: 1000, free: 2000 },
      operations: { read: 10, write: 5 },
      bandwidth: { read: 1024, write: 512 },
      total: { readOps: 100, writeOps: 50, readBytes: 10240, writeBytes: 5120 },
      id: name,
      timestamp: Date.now(),
      rates: {
        readOpsPerSec: 10,
        writeOpsPerSec: 5,
        readBytesPerSec: 1024,
        writeBytesPerSec: 512,
        utilizationPercent: 33.33,
      },
    };
  }

  it('should build simple pool hierarchy', () => {
    const stats = [createMockStat('tank', 0)];
    const hierarchy = buildHierarchy(stats);

    expect(hierarchy.size).toBe(1);
    expect(hierarchy.has('tank')).toBe(true);

    const pool = hierarchy.get('tank')!;
    expect(pool.data.name).toBe('tank');
    expect(pool.vdevs.size).toBe(0);
    expect(pool.individualDisks.size).toBe(0);
  });

  it('should build pool with mirror vdevs', () => {
    const stats = [
      createMockStat('tank', 0),
      createMockStat('mirror-0', 2),
      createMockStat('mirror-1', 2),
    ];

    const hierarchy = buildHierarchy(stats);
    const pool = hierarchy.get('tank')!;

    expect(pool.vdevs.size).toBe(2);
    expect(pool.vdevs.has('mirror-0')).toBe(true);
    expect(pool.vdevs.has('mirror-1')).toBe(true);
  });

  it('should build pool with vdev containing disks', () => {
    const stats = [
      createMockStat('tank', 0),
      createMockStat('mirror-0', 2),
      createMockStat('sda1', 4),
      createMockStat('sdb1', 4),
    ];

    const hierarchy = buildHierarchy(stats);
    const pool = hierarchy.get('tank')!;
    const vdev = pool.vdevs.get('mirror-0')!;

    expect(vdev.disks.size).toBe(2);
    expect(vdev.disks.has('sda1')).toBe(true);
    expect(vdev.disks.has('sdb1')).toBe(true);
  });

  it('should handle individual disks directly under pool', () => {
    const stats = [
      createMockStat('tank', 0),
      createMockStat('sda1', 4), // Disk without vdev parent
    ];

    const hierarchy = buildHierarchy(stats);
    const pool = hierarchy.get('tank')!;

    expect(pool.vdevs.size).toBe(0);
    expect(pool.individualDisks.size).toBe(1);
    expect(pool.individualDisks.has('sda1')).toBe(true);
  });

  it('should handle multiple pools', () => {
    const stats = [
      createMockStat('tank', 0),
      createMockStat('mirror-0', 2),
      createMockStat('backup', 0),
      createMockStat('raidz-0', 2),
    ];

    const hierarchy = buildHierarchy(stats);

    expect(hierarchy.size).toBe(2);
    expect(hierarchy.has('tank')).toBe(true);
    expect(hierarchy.has('backup')).toBe(true);

    const tankVdevs = hierarchy.get('tank')!.vdevs;
    const backupVdevs = hierarchy.get('backup')!.vdevs;

    expect(tankVdevs.has('mirror-0')).toBe(true);
    expect(backupVdevs.has('raidz-0')).toBe(true);
  });

  it('should reset current vdev when new pool starts', () => {
    const stats = [
      createMockStat('tank', 0),
      createMockStat('mirror-0', 2),
      createMockStat('sda1', 4),
      createMockStat('backup', 0), // New pool
      createMockStat('sdb1', 4), // Should not be under mirror-0
    ];

    const hierarchy = buildHierarchy(stats);
    const tankPool = hierarchy.get('tank')!;
    const backupPool = hierarchy.get('backup')!;

    // sda1 should be under mirror-0 in tank
    expect(tankPool.vdevs.get('mirror-0')!.disks.has('sda1')).toBe(true);

    // sdb1 should be individual disk under backup (no vdev)
    expect(backupPool.individualDisks.has('sdb1')).toBe(true);
    expect(backupPool.vdevs.size).toBe(0);
  });

  it('should log warning for vdev without pool', () => {
    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    const stats = [createMockStat('mirror-0', 2)]; // No pool first
    buildHierarchy(stats);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[buildHierarchy] Found vdev without pool:',
      'mirror-0'
    );

    consoleWarnSpy.mockRestore();
  });

  it('should log warning for disk without pool', () => {
    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    const stats = [createMockStat('sda1', 4)]; // No pool first
    buildHierarchy(stats);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[buildHierarchy] Found disk without pool:',
      'sda1'
    );

    consoleWarnSpy.mockRestore();
  });

  it('should handle complex real-world hierarchy', () => {
    const stats = [
      createMockStat('tank', 0),
      createMockStat('mirror-0', 2),
      createMockStat('sda1', 4),
      createMockStat('sdb1', 4),
      createMockStat('mirror-1', 2),
      createMockStat('sdc1', 4),
      createMockStat('sdd1', 4),
      createMockStat('cache', 2),
      createMockStat('nvme0n1', 4),
    ];

    const hierarchy = buildHierarchy(stats);
    const pool = hierarchy.get('tank')!;

    expect(pool.vdevs.size).toBe(3);
    expect(pool.vdevs.get('mirror-0')!.disks.size).toBe(2);
    expect(pool.vdevs.get('mirror-1')!.disks.size).toBe(2);
    expect(pool.vdevs.get('cache')!.disks.size).toBe(1);
  });

  it('should handle multiple disks under multiple vdevs in one pool', () => {
    const stats = [
      createMockStat('tank', 0),
      createMockStat('raidz-0', 2),
      createMockStat('sda', 4),
      createMockStat('sdb', 4),
      createMockStat('sdc', 4),
      createMockStat('raidz-1', 2),
      createMockStat('sdd', 4),
      createMockStat('sde', 4),
      createMockStat('sdf', 4),
    ];

    const hierarchy = buildHierarchy(stats);
    const pool = hierarchy.get('tank')!;

    expect(pool.vdevs.size).toBe(2);

    const raidz0 = pool.vdevs.get('raidz-0')!;
    expect(raidz0.disks.size).toBe(3);
    expect(raidz0.disks.has('sda')).toBe(true);
    expect(raidz0.disks.has('sdb')).toBe(true);
    expect(raidz0.disks.has('sdc')).toBe(true);

    const raidz1 = pool.vdevs.get('raidz-1')!;
    expect(raidz1.disks.size).toBe(3);
    expect(raidz1.disks.has('sdd')).toBe(true);
    expect(raidz1.disks.has('sde')).toBe(true);
    expect(raidz1.disks.has('sdf')).toBe(true);
  });

  it('should handle empty stats array', () => {
    const hierarchy = buildHierarchy([]);
    expect(hierarchy.size).toBe(0);
  });

  it('should preserve all stat data in hierarchy', () => {
    const poolStat = createMockStat('tank', 0);
    poolStat.capacity.alloc = 123456;
    poolStat.rates.readOpsPerSec = 999;

    const stats = [poolStat];
    const hierarchy = buildHierarchy(stats);
    const pool = hierarchy.get('tank')!;

    expect(pool.data.capacity.alloc).toBe(123456);
    expect(pool.data.rates.readOpsPerSec).toBe(999);
  });

  it('should handle vdevs with different indent levels', () => {
    const stats = [
      createMockStat('tank', 0),
      createMockStat('mirror-0', 1), // Indent 1 (still treated as vdev since <= 2)
      createMockStat('sda', 4),
      createMockStat('mirror-1', 2), // Indent 2
      createMockStat('sdb', 6), // Indent 6 (still disk since >= 4)
    ];

    const hierarchy = buildHierarchy(stats);
    const pool = hierarchy.get('tank')!;

    expect(pool.vdevs.size).toBe(2);
    expect(pool.vdevs.has('mirror-0')).toBe(true);
    expect(pool.vdevs.has('mirror-1')).toBe(true);

    expect(pool.vdevs.get('mirror-0')!.disks.has('sda')).toBe(true);
    expect(pool.vdevs.get('mirror-1')!.disks.has('sdb')).toBe(true);
  });

  it('should handle mixed scenarios with individual disks and vdevs', () => {
    const stats = [
      createMockStat('tank', 0),
      createMockStat('sda', 4), // Individual disk first
      createMockStat('mirror-0', 2), // Then a vdev
      createMockStat('sdb', 4), // Disk under vdev
      createMockStat('sdc', 4), // Another disk under vdev
      createMockStat('sdd', 4), // This should still be under mirror-0
    ];

    const hierarchy = buildHierarchy(stats);
    const pool = hierarchy.get('tank')!;

    // sda should be individual disk
    expect(pool.individualDisks.has('sda')).toBe(true);

    // mirror-0 should have 3 disks
    const mirror0 = pool.vdevs.get('mirror-0')!;
    expect(mirror0.disks.size).toBe(3);
    expect(mirror0.disks.has('sdb')).toBe(true);
    expect(mirror0.disks.has('sdc')).toBe(true);
    expect(mirror0.disks.has('sdd')).toBe(true);
  });

  it('should handle pool with indent 0 and negative indent (edge case)', () => {
    const stats = [
      createMockStat('tank', -1), // Negative indent (treated as pool)
      createMockStat('backup', 0), // Normal pool
    ];

    const hierarchy = buildHierarchy(stats);

    expect(hierarchy.size).toBe(2);
    expect(hierarchy.has('tank')).toBe(true);
    expect(hierarchy.has('backup')).toBe(true);
  });

  it('should update current pool when new pool encountered', () => {
    const stats = [
      createMockStat('tank', 0),
      createMockStat('mirror-0', 2),
      createMockStat('sda', 4),
      createMockStat('backup', 0), // New pool - should reset state
      createMockStat('mirror-1', 2), // This vdev belongs to backup
      createMockStat('sdb', 4), // This disk belongs to mirror-1 in backup
    ];

    const hierarchy = buildHierarchy(stats);

    const tank = hierarchy.get('tank')!;
    const backup = hierarchy.get('backup')!;

    // Verify tank structure
    expect(tank.vdevs.has('mirror-0')).toBe(true);
    expect(tank.vdevs.get('mirror-0')!.disks.has('sda')).toBe(true);
    expect(tank.vdevs.has('mirror-1')).toBe(false);

    // Verify backup structure
    expect(backup.vdevs.has('mirror-1')).toBe(true);
    expect(backup.vdevs.get('mirror-1')!.disks.has('sdb')).toBe(true);
  });

  it('should correctly assign disks after vdev ends', () => {
    const stats = [
      createMockStat('tank', 0),
      createMockStat('mirror-0', 2),
      createMockStat('sda', 4),
      createMockStat('mirror-1', 2), // New vdev - sda should not continue to be added here
      createMockStat('sdb', 4),
    ];

    const hierarchy = buildHierarchy(stats);
    const pool = hierarchy.get('tank')!;

    const mirror0 = pool.vdevs.get('mirror-0')!;
    const mirror1 = pool.vdevs.get('mirror-1')!;

    expect(mirror0.disks.size).toBe(1);
    expect(mirror0.disks.has('sda')).toBe(true);
    expect(mirror0.disks.has('sdb')).toBe(false);

    expect(mirror1.disks.size).toBe(1);
    expect(mirror1.disks.has('sdb')).toBe(true);
    expect(mirror1.disks.has('sda')).toBe(false);
  });

  describe('rowToZFSStats', () => {
    function createMockRow(overrides?: Partial<ZFSStatsRow>): ZFSStatsRow {
      return {
        time: '2024-01-01T00:00:00Z',
        pool: 'tank',
        entity: 'tank',
        entity_type: 'pool',
        indent: 0,
        capacity_alloc: 1000000,
        capacity_free: 2000000,
        read_ops_per_sec: 10,
        write_ops_per_sec: 5,
        read_bytes_per_sec: 1024,
        write_bytes_per_sec: 512,
        utilization_percent: 33.3,
        ...overrides,
      };
    }

    it('should convert a ZFSStatsRow to ZFSIOStatWithRates', () => {
      const row = createMockRow();
      const result = rowToZFSStats(row);

      expect(result.id).toBe('tank');
      expect(result.name).toBe('tank');
      expect(result.indent).toBe(0);
      expect(result.capacity.alloc).toBe(1000000);
      expect(result.capacity.free).toBe(2000000);
      expect(result.operations.read).toBe(10);
      expect(result.operations.write).toBe(5);
      expect(result.bandwidth.read).toBe(1024);
      expect(result.bandwidth.write).toBe(512);
      expect(result.rates.readOpsPerSec).toBe(10);
      expect(result.rates.writeBytesPerSec).toBe(512);
      expect(result.rates.utilizationPercent).toBe(33.3);
    });

    it('should extract name from entity path', () => {
      const row = createMockRow({ entity: 'tank/mirror-0' });
      const result = rowToZFSStats(row);

      expect(result.id).toBe('tank/mirror-0');
      expect(result.name).toBe('mirror-0');
    });

    it('should extract disk name from deep entity path', () => {
      const row = createMockRow({ entity: 'tank/mirror-0/sda' });
      const result = rowToZFSStats(row);

      expect(result.name).toBe('sda');
    });

    it('should default null metrics to 0', () => {
      const row = createMockRow({
        capacity_alloc: null,
        capacity_free: null,
        read_ops_per_sec: null,
        write_ops_per_sec: null,
        read_bytes_per_sec: null,
        write_bytes_per_sec: null,
        utilization_percent: null,
      });
      const result = rowToZFSStats(row);

      expect(result.capacity.alloc).toBe(0);
      expect(result.capacity.free).toBe(0);
      expect(result.operations.read).toBe(0);
      expect(result.operations.write).toBe(0);
      expect(result.bandwidth.read).toBe(0);
      expect(result.bandwidth.write).toBe(0);
      expect(result.rates.readOpsPerSec).toBe(0);
      expect(result.rates.utilizationPercent).toBe(0);
    });

    it('should set total fields to 0', () => {
      const row = createMockRow();
      const result = rowToZFSStats(row);

      expect(result.total.readOps).toBe(0);
      expect(result.total.writeOps).toBe(0);
      expect(result.total.readBytes).toBe(0);
      expect(result.total.writeBytes).toBe(0);
    });
  });

  it('should handle vdev names with special characters', () => {
    const stats = [
      createMockStat('tank', 0),
      createMockStat('mirror-0', 2),
      createMockStat('raidz1-0', 2),
      createMockStat('raidz2-data-0', 2),
      createMockStat('spare-1', 2),
    ];

    const hierarchy = buildHierarchy(stats);
    const pool = hierarchy.get('tank')!;

    expect(pool.vdevs.size).toBe(4);
    expect(pool.vdevs.has('mirror-0')).toBe(true);
    expect(pool.vdevs.has('raidz1-0')).toBe(true);
    expect(pool.vdevs.has('raidz2-data-0')).toBe(true);
    expect(pool.vdevs.has('spare-1')).toBe(true);
  });
});
