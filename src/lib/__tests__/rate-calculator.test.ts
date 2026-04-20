import { describe, it, expect, beforeEach } from 'bun:test';
import type Dockerode from 'dockerode';
import {
  DockerRateCalculator,
  computeCpuPercent,
  computeMemoryPercent,
  sumNetworkBytes,
  computeNetworkRates,
  findBlkioBytes,
  computeBlockIoRates,
} from '../rate-calculator';

// Narrow fixture builders: each returns a partial Dockerode.ContainerStats with only
// the fields the helper under test actually reads. Casting to ContainerStats keeps the
// helper signatures simple while letting tests stay focused on what matters.

function withCpu(total_usage: number, system_cpu_usage: number, online_cpus = 4): Dockerode.ContainerStats {
  return {
    cpu_stats: {
      cpu_usage: { total_usage },
      system_cpu_usage,
      online_cpus,
    },
  } as unknown as Dockerode.ContainerStats;
}

function withMemory(usage: number | undefined, limit: number | undefined): Dockerode.ContainerStats {
  return {
    memory_stats: { usage, limit },
  } as unknown as Dockerode.ContainerStats;
}

function withNetworks(
  ifaces: Record<string, { rx_bytes?: number; tx_bytes?: number }> | undefined,
): Dockerode.ContainerStats {
  return { networks: ifaces } as unknown as Dockerode.ContainerStats;
}

function withBlkio(
  entries: Array<{ op: string; value: number }> | undefined,
): Dockerode.ContainerStats {
  if (entries === undefined) return { blkio_stats: {} } as unknown as Dockerode.ContainerStats;
  return {
    blkio_stats: { io_service_bytes_recursive: entries },
  } as unknown as Dockerode.ContainerStats;
}

describe('computeCpuPercent', () => {
  it('returns (cpuDelta / systemDelta) * cpuCount * 100', () => {
    // 200M / 1B * 4 * 100 = 80%
    const prev = withCpu(1_000_000_000, 10_000_000_000, 4);
    const curr = withCpu(1_200_000_000, 11_000_000_000, 4);
    expect(computeCpuPercent(prev, curr)).toBeCloseTo(80, 1);
  });

  it('returns 0 when systemDelta is zero', () => {
    const prev = withCpu(1_000_000_000, 10_000_000_000);
    const curr = withCpu(1_200_000_000, 10_000_000_000);
    expect(computeCpuPercent(prev, curr)).toBe(0);
  });

  it('returns 0 when systemDelta is negative', () => {
    const prev = withCpu(1_000_000_000, 10_000_000_000);
    const curr = withCpu(1_200_000_000, 9_000_000_000);
    expect(computeCpuPercent(prev, curr)).toBe(0);
  });

  it('returns 0 when cpuDelta is negative (counter reset)', () => {
    const prev = withCpu(1_200_000_000, 10_000_000_000);
    const curr = withCpu(1_000_000_000, 11_000_000_000);
    expect(computeCpuPercent(prev, curr)).toBe(0);
  });

  it('treats falsy online_cpus as 1', () => {
    // 200M / 1B * 1 * 100 = 20%
    const prev = withCpu(1_000_000_000, 10_000_000_000, 0);
    const curr = withCpu(1_200_000_000, 11_000_000_000, 0);
    expect(computeCpuPercent(prev, curr)).toBeCloseTo(20, 1);
  });
});

describe('computeMemoryPercent', () => {
  it('returns usage / limit * 100', () => {
    expect(computeMemoryPercent(withMemory(512, 1024))).toBeCloseTo(50, 1);
  });

  it('treats missing usage as 0', () => {
    expect(computeMemoryPercent(withMemory(undefined, 1024))).toBe(0);
  });

  it('treats missing limit as 1 to avoid division by zero', () => {
    expect(computeMemoryPercent(withMemory(50, undefined))).toBe(5000);
  });

  it('handles missing memory_stats entirely', () => {
    expect(computeMemoryPercent({} as Dockerode.ContainerStats)).toBe(0);
  });
});

describe('sumNetworkBytes', () => {
  it('sums rx/tx across all interfaces', () => {
    const stats = withNetworks({
      eth0: { rx_bytes: 100, tx_bytes: 50 },
      eth1: { rx_bytes: 30, tx_bytes: 15 },
    });
    expect(sumNetworkBytes(stats)).toEqual({ rx: 130, tx: 65 });
  });

  it('returns zeros when networks is undefined', () => {
    expect(sumNetworkBytes(withNetworks(undefined))).toEqual({ rx: 0, tx: 0 });
  });

  it('treats missing rx_bytes/tx_bytes as 0', () => {
    const stats = withNetworks({ eth0: {} });
    expect(sumNetworkBytes(stats)).toEqual({ rx: 0, tx: 0 });
  });
});

describe('computeNetworkRates', () => {
  it('returns delta / timeDeltaSec for both directions', () => {
    const prev = withNetworks({ eth0: { rx_bytes: 100, tx_bytes: 50 } });
    const curr = withNetworks({ eth0: { rx_bytes: 300, tx_bytes: 150 } });
    expect(computeNetworkRates(prev, curr, 2)).toEqual({
      networkRxBytesPerSec: 100,
      networkTxBytesPerSec: 50,
    });
  });

  it('returns zeros when curr.networks is missing', () => {
    const prev = withNetworks({ eth0: { rx_bytes: 100, tx_bytes: 50 } });
    const curr = withNetworks(undefined);
    expect(computeNetworkRates(prev, curr, 1)).toEqual({
      networkRxBytesPerSec: 0,
      networkTxBytesPerSec: 0,
    });
  });

  it('returns zeros when prev.networks is missing', () => {
    const prev = withNetworks(undefined);
    const curr = withNetworks({ eth0: { rx_bytes: 100, tx_bytes: 50 } });
    expect(computeNetworkRates(prev, curr, 1)).toEqual({
      networkRxBytesPerSec: 0,
      networkTxBytesPerSec: 0,
    });
  });

  it('clamps negative deltas (counter reset) to 0 per direction', () => {
    const prev = withNetworks({ eth0: { rx_bytes: 100, tx_bytes: 50 } });
    const curr = withNetworks({ eth0: { rx_bytes: 10, tx_bytes: 200 } });
    expect(computeNetworkRates(prev, curr, 1)).toEqual({
      networkRxBytesPerSec: 0, // clamped
      networkTxBytesPerSec: 150,
    });
  });

  it('sums across multiple interfaces', () => {
    const prev = withNetworks({
      eth0: { rx_bytes: 100, tx_bytes: 50 },
      eth1: { rx_bytes: 200, tx_bytes: 100 },
    });
    const curr = withNetworks({
      eth0: { rx_bytes: 200, tx_bytes: 100 },
      eth1: { rx_bytes: 400, tx_bytes: 200 },
    });
    expect(computeNetworkRates(prev, curr, 1)).toEqual({
      networkRxBytesPerSec: 300, // (200-100) + (400-200)
      networkTxBytesPerSec: 150, // (100-50) + (200-100)
    });
  });
});

describe('findBlkioBytes', () => {
  it('finds lowercase op', () => {
    const stats = withBlkio([
      { op: 'read', value: 1000 },
      { op: 'write', value: 500 },
    ]);
    expect(findBlkioBytes(stats, 'read')).toBe(1000);
    expect(findBlkioBytes(stats, 'write')).toBe(500);
  });

  it('finds capitalized op (older Docker versions)', () => {
    const stats = withBlkio([
      { op: 'Read', value: 1000 },
      { op: 'Write', value: 500 },
    ]);
    expect(findBlkioBytes(stats, 'read')).toBe(1000);
    expect(findBlkioBytes(stats, 'write')).toBe(500);
  });

  it('returns 0 when op not found', () => {
    expect(findBlkioBytes(withBlkio([{ op: 'read', value: 1000 }]), 'write')).toBe(0);
  });

  it('returns 0 when blkio_stats is missing the recursive array', () => {
    expect(findBlkioBytes(withBlkio(undefined), 'read')).toBe(0);
  });
});

describe('computeBlockIoRates', () => {
  it('returns delta / timeDeltaSec for read and write', () => {
    const prev = withBlkio([
      { op: 'read', value: 1000 },
      { op: 'write', value: 500 },
    ]);
    const curr = withBlkio([
      { op: 'read', value: 3000 },
      { op: 'write', value: 1500 },
    ]);
    expect(computeBlockIoRates(prev, curr, 2)).toEqual({
      blockIoReadBytesPerSec: 1000,
      blockIoWriteBytesPerSec: 500,
    });
  });

  it('returns zeros when curr blkio data is missing', () => {
    const prev = withBlkio([{ op: 'read', value: 1000 }]);
    const curr = withBlkio(undefined);
    expect(computeBlockIoRates(prev, curr, 1)).toEqual({
      blockIoReadBytesPerSec: 0,
      blockIoWriteBytesPerSec: 0,
    });
  });

  it('returns zeros when prev blkio data is missing', () => {
    const prev = withBlkio(undefined);
    const curr = withBlkio([{ op: 'read', value: 1000 }]);
    expect(computeBlockIoRates(prev, curr, 1)).toEqual({
      blockIoReadBytesPerSec: 0,
      blockIoWriteBytesPerSec: 0,
    });
  });

  it('clamps negative deltas to 0 per direction', () => {
    const prev = withBlkio([
      { op: 'read', value: 1000 },
      { op: 'write', value: 500 },
    ]);
    const curr = withBlkio([
      { op: 'read', value: 100 }, // counter reset
      { op: 'write', value: 1500 },
    ]);
    expect(computeBlockIoRates(prev, curr, 1)).toEqual({
      blockIoReadBytesPerSec: 0,
      blockIoWriteBytesPerSec: 1000,
    });
  });
});

// Orchestration tests for DockerRateCalculator.calculate / clear / remove.
// The math is covered by the per-helper tests above; these only verify that
// calculate wires the pieces together: cache lifecycle, time-delta gating,
// injected clock, and result shape.

function mockStats(overrides: Partial<{ rx: number; tx: number; cpu: number; sysCpu: number; memUsage: number }> = {}): Dockerode.ContainerStats {
  const { rx = 100, tx = 50, cpu = 1_000_000_000, sysCpu = 10_000_000_000, memUsage = 512 } = overrides;
  return {
    cpu_stats: {
      cpu_usage: { total_usage: cpu },
      system_cpu_usage: sysCpu,
      online_cpus: 4,
    },
    memory_stats: { usage: memUsage, limit: 1024 },
    networks: { eth0: { rx_bytes: rx, tx_bytes: tx } },
    blkio_stats: {
      io_service_bytes_recursive: [
        { op: 'read', value: 0 },
        { op: 'write', value: 0 },
      ],
    },
  } as unknown as Dockerode.ContainerStats;
}

describe('DockerRateCalculator', () => {
  let calculator: DockerRateCalculator;
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    calculator = new DockerRateCalculator(() => now);
  });

  describe('calculate', () => {
    it('returns the current stats with id, name, and rates appended', () => {
      const stats = mockStats();
      const result = calculator.calculate('c1', { containerId: 'c1', containerName: 'web', stats });

      expect(result.id).toBe('c1');
      expect(result.name).toBe('web');
      expect(result.rates).toBeDefined();
      // Original stats fields are preserved on the result
      expect(result.cpu_stats).toBe(stats.cpu_stats);
    });

    it('always returns memoryPercent (no delta required)', () => {
      const stats = mockStats({ memUsage: 256 });
      const result = calculator.calculate('c1', { containerId: 'c1', containerName: 'web', stats });
      expect(result.rates.memoryPercent).toBeCloseTo(25, 1);
    });

    it('returns zero rate fields on first call (no previous data)', () => {
      const result = calculator.calculate('c1', { containerId: 'c1', containerName: 'web', stats: mockStats() });
      expect(result.rates.cpuPercent).toBe(0);
      expect(result.rates.networkRxBytesPerSec).toBe(0);
      expect(result.rates.networkTxBytesPerSec).toBe(0);
      expect(result.rates.blockIoReadBytesPerSec).toBe(0);
      expect(result.rates.blockIoWriteBytesPerSec).toBe(0);
    });

    it('uses the injected clock for the cache timestamp', () => {
      calculator.calculate('c1', { containerId: 'c1', containerName: 'web', stats: mockStats({ rx: 100 }) });
      now += 2000;
      const result = calculator.calculate('c1', { containerId: 'c1', containerName: 'web', stats: mockStats({ rx: 300 }) });
      // 200 byte delta over 2s = 100 B/s
      expect(result.rates.networkRxBytesPerSec).toBe(100);
    });

    it('returns zero rates when two calls share the same timestamp (timeDeltaSec === 0)', () => {
      calculator.calculate('c1', { containerId: 'c1', containerName: 'web', stats: mockStats({ rx: 100 }) });
      // No clock advance
      const result = calculator.calculate('c1', { containerId: 'c1', containerName: 'web', stats: mockStats({ rx: 300 }) });
      expect(result.rates.networkRxBytesPerSec).toBe(0);
    });

    it('tracks multiple containers independently', () => {
      calculator.calculate('c1', { containerId: 'c1', containerName: 'a', stats: mockStats({ rx: 100 }) });
      calculator.calculate('c2', { containerId: 'c2', containerName: 'b', stats: mockStats({ rx: 200 }) });
      now += 1000;
      const r1 = calculator.calculate('c1', { containerId: 'c1', containerName: 'a', stats: mockStats({ rx: 200 }) });
      const r2 = calculator.calculate('c2', { containerId: 'c2', containerName: 'b', stats: mockStats({ rx: 500 }) });
      expect(r1.rates.networkRxBytesPerSec).toBe(100);
      expect(r2.rates.networkRxBytesPerSec).toBe(300);
    });
  });

  describe('clear', () => {
    it('drops all cached previous-stats entries', () => {
      calculator.calculate('c1', { containerId: 'c1', containerName: 'a', stats: mockStats({ rx: 100 }) });
      calculator.calculate('c2', { containerId: 'c2', containerName: 'b', stats: mockStats({ rx: 100 }) });
      calculator.clear();
      now += 1000;

      // Without cached previous data, second calls behave like first calls
      const r1 = calculator.calculate('c1', { containerId: 'c1', containerName: 'a', stats: mockStats({ rx: 200 }) });
      const r2 = calculator.calculate('c2', { containerId: 'c2', containerName: 'b', stats: mockStats({ rx: 200 }) });
      expect(r1.rates.networkRxBytesPerSec).toBe(0);
      expect(r2.rates.networkRxBytesPerSec).toBe(0);
    });
  });

  describe('remove', () => {
    it('drops only the named container from the cache', () => {
      calculator.calculate('c1', { containerId: 'c1', containerName: 'a', stats: mockStats({ rx: 100 }) });
      calculator.calculate('c2', { containerId: 'c2', containerName: 'b', stats: mockStats({ rx: 100 }) });
      calculator.remove('c1');
      now += 1000;

      const r1 = calculator.calculate('c1', { containerId: 'c1', containerName: 'a', stats: mockStats({ rx: 200 }) });
      const r2 = calculator.calculate('c2', { containerId: 'c2', containerName: 'b', stats: mockStats({ rx: 200 }) });
      expect(r1.rates.networkRxBytesPerSec).toBe(0); // cleared
      expect(r2.rates.networkRxBytesPerSec).toBe(100); // still cached
    });
  });
});
