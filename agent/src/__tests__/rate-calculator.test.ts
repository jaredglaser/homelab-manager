import { describe, expect, test, beforeEach, spyOn } from 'bun:test';
import { RateCalculator } from '../rate-calculator';

describe('RateCalculator', () => {
  let calculator: RateCalculator;
  let currentTime: number;

  beforeEach(() => {
    calculator = new RateCalculator();
    currentTime = 1000000;
    spyOn(Date, 'now').mockImplementation(() => currentTime);
  });

  test('returns null on first call (no previous data)', () => {
    const stats = createMockStats({ cpuDelta: 100, systemDelta: 1000 });
    const result = calculator.calculate('container1', stats);
    expect(result).toBeNull();
  });

  test('calculates CPU percentage on second call', () => {
    const stats1 = createMockStats({ cpuTotal: 100, systemCpu: 1000, onlineCpus: 4 });
    calculator.calculate('container1', stats1);
    currentTime += 1000;
    const stats2 = createMockStats({ cpuTotal: 200, systemCpu: 2000, onlineCpus: 4 });
    const result = calculator.calculate('container1', stats2);
    expect(result).not.toBeNull();
    expect(result!.cpuPercent).toBeCloseTo(40);
  });

  test('calculates memory percentage', () => {
    const stats1 = createMockStats({ memUsage: 512, memLimit: 1024 });
    calculator.calculate('container1', stats1);
    currentTime += 1000;
    const stats2 = createMockStats({ memUsage: 512, memLimit: 1024 });
    const result = calculator.calculate('container1', stats2);
    expect(result).not.toBeNull();
    expect(result!.memoryPercent).toBeCloseTo(50);
  });

  test('calculates network bytes per second', () => {
    const stats1 = createMockStats({ rxBytes: 1000, txBytes: 500 });
    calculator.calculate('container1', stats1);
    currentTime += 1000;
    const stats2 = createMockStats({ rxBytes: 2000, txBytes: 1500 });
    const result = calculator.calculate('container1', stats2);
    expect(result).not.toBeNull();
    expect(result!.networkRxBytesPerSec).toBe(1000);
    expect(result!.networkTxBytesPerSec).toBe(1000);
  });

  test('remove clears cached data for a container', () => {
    calculator.calculate('container1', createMockStats({}));
    calculator.remove('container1');
    expect(calculator.calculate('container1', createMockStats({}))).toBeNull();
  });

  test('clear removes all cached data', () => {
    calculator.calculate('c1', createMockStats({}));
    calculator.calculate('c2', createMockStats({}));
    calculator.clear();
    expect(calculator.calculate('c1', createMockStats({}))).toBeNull();
    expect(calculator.calculate('c2', createMockStats({}))).toBeNull();
  });
});

function createMockStats(overrides: {
  cpuTotal?: number; cpuDelta?: number; systemCpu?: number; systemDelta?: number;
  onlineCpus?: number; memUsage?: number; memLimit?: number;
  rxBytes?: number; txBytes?: number; readBytes?: number; writeBytes?: number;
}) {
  return {
    read: new Date().toISOString(),
    cpu_stats: {
      cpu_usage: { total_usage: overrides.cpuTotal ?? 0 },
      system_cpu_usage: overrides.systemCpu ?? 0,
      online_cpus: overrides.onlineCpus ?? 1,
    },
    precpu_stats: {
      cpu_usage: { total_usage: (overrides.cpuTotal ?? 0) - (overrides.cpuDelta ?? 0) },
      system_cpu_usage: (overrides.systemCpu ?? 0) - (overrides.systemDelta ?? 0),
    },
    memory_stats: { usage: overrides.memUsage ?? 0, limit: overrides.memLimit ?? 1 },
    networks: { eth0: { rx_bytes: overrides.rxBytes ?? 0, tx_bytes: overrides.txBytes ?? 0 } },
    blkio_stats: {
      io_service_bytes_recursive: [
        { op: 'read', value: overrides.readBytes ?? 0 },
        { op: 'write', value: overrides.writeBytes ?? 0 },
      ],
    },
  };
}
