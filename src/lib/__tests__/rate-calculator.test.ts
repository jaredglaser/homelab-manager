import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import type Dockerode from 'dockerode';
import { DockerRateCalculator } from '../rate-calculator';

let calculator: DockerRateCalculator;

// Helper to create mock Docker stats
function createMockStats(overrides: Partial<Dockerode.ContainerStats> = {}): Dockerode.ContainerStats {
  return {
    read: new Date().toISOString(),
    preread: new Date(Date.now() - 1000).toISOString(),
    pids_stats: { current: 10 },
    blkio_stats: {
      io_service_bytes_recursive: [
        { major: 8, minor: 0, op: 'read', value: 1024 * 1024 * 10 }, // 10 MB read
        { major: 8, minor: 0, op: 'write', value: 1024 * 1024 * 5 }, // 5 MB write
      ],
      io_serviced_recursive: [],
      io_queue_recursive: [],
      io_service_time_recursive: [],
      io_wait_time_recursive: [],
      io_merged_recursive: [],
      io_time_recursive: [],
      sectors_recursive: [],
    },
    num_procs: 0,
    storage_stats: {},
    cpu_stats: {
      cpu_usage: {
        total_usage: 1000000000, // 1 billion nanoseconds
        percpu_usage: [250000000, 250000000, 250000000, 250000000],
        usage_in_kernelmode: 100000000,
        usage_in_usermode: 900000000,
      },
      system_cpu_usage: 10000000000, // 10 billion nanoseconds
      online_cpus: 4,
      throttling_data: {
        periods: 0,
        throttled_periods: 0,
        throttled_time: 0,
      },
    },
    precpu_stats: {
      cpu_usage: {
        total_usage: 800000000, // 800 million nanoseconds (200M delta)
        percpu_usage: [200000000, 200000000, 200000000, 200000000],
        usage_in_kernelmode: 80000000,
        usage_in_usermode: 720000000,
      },
      system_cpu_usage: 9000000000, // 9 billion nanoseconds (1B delta)
      online_cpus: 4,
      throttling_data: {
        periods: 0,
        throttled_periods: 0,
        throttled_time: 0,
      },
    },
    memory_stats: {
      usage: 1024 * 1024 * 512, // 512 MB
      max_usage: 1024 * 1024 * 600,
      stats: {
        active_anon: 0,
        active_file: 0,
        cache: 0,
        dirty: 0,
        hierarchical_memory_limit: 0,
        hierarchical_memsw_limit: 0,
        inactive_anon: 0,
        inactive_file: 0,
        mapped_file: 0,
        pgfault: 0,
        pgmajfault: 0,
        pgpgin: 0,
        pgpgout: 0,
        rss: 0,
        rss_huge: 0,
        total_active_anon: 0,
        total_active_file: 0,
        total_cache: 0,
        total_dirty: 0,
        total_inactive_anon: 0,
        total_inactive_file: 0,
        total_mapped_file: 0,
        total_pgfault: 0,
        total_pgmajfault: 0,
        total_pgpgin: 0,
        total_pgpgout: 0,
        total_rss: 0,
        total_rss_huge: 0,
        total_unevictable: 0,
        total_writeback: 0,
        unevictable: 0,
        writeback: 0,
      },
      limit: 1024 * 1024 * 1024, // 1 GB limit
    },
    name: '/test-container',
    id: 'abc123',
    networks: {
      eth0: {
        rx_bytes: 1024 * 1024 * 100, // 100 MB received
        rx_packets: 1000,
        rx_errors: 0,
        rx_dropped: 0,
        tx_bytes: 1024 * 1024 * 50, // 50 MB transmitted
        tx_packets: 500,
        tx_errors: 0,
        tx_dropped: 0,
      },
    },
    ...overrides,
  } as Dockerode.ContainerStats;
}

function calculate(containerId: string, containerName: string, stats: Dockerode.ContainerStats) {
  return calculator.calculate(containerId, { containerId, containerName, stats });
}

describe('DockerRateCalculator.calculate', () => {
  beforeEach(() => {
    calculator = new DockerRateCalculator();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should calculate memory percentage on first call', () => {
    const stats = createMockStats();
    const result = calculate('container1', 'test-container', stats);

    expect(result.id).toBe('container1');
    expect(result.name).toBe('test-container');
    expect(result.rates.memoryPercent).toBeCloseTo(50, 1); // 512 MB / 1024 MB = 50%
  });

  it('should return zero rates on first call (no previous data)', () => {
    const stats = createMockStats();
    const result = calculate('container1', 'test-container', stats);

    expect(result.rates.cpuPercent).toBe(0);
    expect(result.rates.networkRxBytesPerSec).toBe(0);
    expect(result.rates.networkTxBytesPerSec).toBe(0);
    expect(result.rates.blockIoReadBytesPerSec).toBe(0);
    expect(result.rates.blockIoWriteBytesPerSec).toBe(0);
  });

  it('should calculate CPU percentage correctly', () => {
    const stats1 = createMockStats();

    // First call - no rates yet
    calculate('container1', 'test-container', stats1);

    // Advance time by 1 second
    jest.advanceTimersByTime(1000);

    // Second call with updated stats
    const stats2 = createMockStats({
      cpu_stats: {
        cpu_usage: {
          total_usage: 1200000000, // 1.2 billion (200M delta from first call)
          percpu_usage: [300000000, 300000000, 300000000, 300000000],
          usage_in_kernelmode: 120000000,
          usage_in_usermode: 1080000000,
        },
        system_cpu_usage: 11000000000, // 11 billion (1B delta)
        online_cpus: 4,
        throttling_data: { periods: 0, throttled_periods: 0, throttled_time: 0 },
      },
    });

    const result = calculate('container1', 'test-container', stats2);

    // CPU calculation: (cpuDelta / systemDelta) * cpuCount * 100
    // (1200000000 - 1000000000) / (11000000000 - 10000000000) * 4 * 100
    // = 200000000 / 1000000000 * 4 * 100 = 0.2 * 4 * 100 = 80%
    expect(result.rates.cpuPercent).toBeCloseTo(80, 1);
  });

  it('should calculate network rates correctly', () => {
    const stats1 = createMockStats({
      networks: {
        eth0: {
          rx_bytes: 1024 * 1024 * 100, // 100 MB
          rx_packets: 1000,
          rx_errors: 0,
          rx_dropped: 0,
          tx_bytes: 1024 * 1024 * 50, // 50 MB
          tx_packets: 500,
          tx_errors: 0,
          tx_dropped: 0,
        },
      },
    });

    calculate('container1', 'test-container', stats1);

    // Advance time by 1 second
    jest.advanceTimersByTime(1000);

    // Second call - 10 MB more received, 5 MB more transmitted
    const stats2 = createMockStats({
      networks: {
        eth0: {
          rx_bytes: 1024 * 1024 * 110, // 110 MB (10 MB delta)
          rx_packets: 1100,
          rx_errors: 0,
          rx_dropped: 0,
          tx_bytes: 1024 * 1024 * 55, // 55 MB (5 MB delta)
          tx_packets: 550,
          tx_errors: 0,
          tx_dropped: 0,
        },
      },
    });

    const result = calculate('container1', 'test-container', stats2);

    // Rate = delta / time (in seconds)
    // RX: 10 MB / 1s = 10 * 1024 * 1024 bytes/sec = 10485760 bytes/sec
    // TX: 5 MB / 1s = 5 * 1024 * 1024 bytes/sec = 5242880 bytes/sec
    expect(result.rates.networkRxBytesPerSec).toBeCloseTo(10 * 1024 * 1024, 0);
    expect(result.rates.networkTxBytesPerSec).toBeCloseTo(5 * 1024 * 1024, 0);
  });

  it('should calculate block IO rates correctly', () => {
    const stats1 = createMockStats({
      blkio_stats: {
        io_service_bytes_recursive: [
          { major: 8, minor: 0, op: 'read', value: 1024 * 1024 * 100 }, // 100 MB
          { major: 8, minor: 0, op: 'write', value: 1024 * 1024 * 50 }, // 50 MB
        ],
        io_serviced_recursive: [],
        io_queue_recursive: [],
        io_service_time_recursive: [],
        io_wait_time_recursive: [],
        io_merged_recursive: [],
        io_time_recursive: [],
        sectors_recursive: [],
      },
    });

    calculate('container1', 'test-container', stats1);

    // Advance time by 2 seconds
    jest.advanceTimersByTime(2000);

    // Second call - 20 MB more read, 10 MB more written
    const stats2 = createMockStats({
      blkio_stats: {
        io_service_bytes_recursive: [
          { major: 8, minor: 0, op: 'read', value: 1024 * 1024 * 120 }, // 120 MB
          { major: 8, minor: 0, op: 'write', value: 1024 * 1024 * 60 }, // 60 MB
        ],
        io_serviced_recursive: [],
        io_queue_recursive: [],
        io_service_time_recursive: [],
        io_wait_time_recursive: [],
        io_merged_recursive: [],
        io_time_recursive: [],
        sectors_recursive: [],
      },
    });

    const result = calculate('container1', 'test-container', stats2);

    // Rate = delta / time
    // Read: 20 MB / 2s = 10 MB/s = 10 * 1024 * 1024 bytes/sec = 10485760 bytes/sec
    // Write: 10 MB / 2s = 5 MB/s = 5 * 1024 * 1024 bytes/sec = 5242880 bytes/sec
    expect(result.rates.blockIoReadBytesPerSec).toBeCloseTo(10 * 1024 * 1024, 0);
    expect(result.rates.blockIoWriteBytesPerSec).toBeCloseTo(5 * 1024 * 1024, 0);
  });

  it('should handle multiple network interfaces', () => {
    const stats1 = createMockStats({
      networks: {
        eth0: {
          rx_bytes: 1024 * 1024 * 50,
          rx_packets: 500,
          rx_errors: 0,
          rx_dropped: 0,
          tx_bytes: 1024 * 1024 * 25,
          tx_packets: 250,
          tx_errors: 0,
          tx_dropped: 0,
        },
        eth1: {
          rx_bytes: 1024 * 1024 * 30,
          rx_packets: 300,
          rx_errors: 0,
          rx_dropped: 0,
          tx_bytes: 1024 * 1024 * 15,
          tx_packets: 150,
          tx_errors: 0,
          tx_dropped: 0,
        },
      },
    });

    calculate('container1', 'test-container', stats1);
    jest.advanceTimersByTime(1000);

    const stats2 = createMockStats({
      networks: {
        eth0: {
          rx_bytes: 1024 * 1024 * 60, // +10 MB
          rx_packets: 600,
          rx_errors: 0,
          rx_dropped: 0,
          tx_bytes: 1024 * 1024 * 30, // +5 MB
          tx_packets: 300,
          tx_errors: 0,
          tx_dropped: 0,
        },
        eth1: {
          rx_bytes: 1024 * 1024 * 40, // +10 MB
          rx_packets: 400,
          rx_errors: 0,
          rx_dropped: 0,
          tx_bytes: 1024 * 1024 * 20, // +5 MB
          tx_packets: 200,
          tx_errors: 0,
          tx_dropped: 0,
        },
      },
    });

    const result = calculate('container1', 'test-container', stats2);

    // Should sum both interfaces
    // RX: (10 + 10) MB/s = 20 MB/s
    // TX: (5 + 5) MB/s = 10 MB/s
    expect(result.rates.networkRxBytesPerSec).toBeCloseTo(20 * 1024 * 1024, 0);
    expect(result.rates.networkTxBytesPerSec).toBeCloseTo(10 * 1024 * 1024, 0);
  });

  it('should handle negative deltas (container restart)', () => {
    const stats1 = createMockStats({
      networks: {
        eth0: {
          rx_bytes: 1024 * 1024 * 100,
          rx_packets: 1000,
          rx_errors: 0,
          rx_dropped: 0,
          tx_bytes: 1024 * 1024 * 50,
          tx_packets: 500,
          tx_errors: 0,
          tx_dropped: 0,
        },
      },
    });

    calculate('container1', 'test-container', stats1);
    jest.advanceTimersByTime(1000);

    // Container restarted - counters reset
    const stats2 = createMockStats({
      networks: {
        eth0: {
          rx_bytes: 1024 * 1024 * 10, // Lower than before (restart)
          rx_packets: 100,
          rx_errors: 0,
          rx_dropped: 0,
          tx_bytes: 1024 * 1024 * 5,
          tx_packets: 50,
          tx_errors: 0,
          tx_dropped: 0,
        },
      },
    });

    const result = calculate('container1', 'test-container', stats2);

    // Should not show negative rates
    expect(result.rates.networkRxBytesPerSec).toBe(0);
    expect(result.rates.networkTxBytesPerSec).toBe(0);
  });

  it('should handle missing network data', () => {
    const stats1 = createMockStats({ networks: undefined });
    const result1 = calculate('container1', 'test-container', stats1);

    expect(result1.rates.networkRxBytesPerSec).toBe(0);
    expect(result1.rates.networkTxBytesPerSec).toBe(0);
  });

  it('should track stats for multiple containers independently', () => {
    const container1Stats1 = createMockStats();
    const container2Stats1 = createMockStats();

    calculate('container1', 'test1', container1Stats1);
    calculate('container2', 'test2', container2Stats1);

    jest.advanceTimersByTime(1000);

    const container1Stats2 = createMockStats({
      networks: {
        eth0: {
          rx_bytes: 1024 * 1024 * 110, // +10 MB
          rx_packets: 1100,
          rx_errors: 0,
          rx_dropped: 0,
          tx_bytes: 1024 * 1024 * 55,
          tx_packets: 550,
          tx_errors: 0,
          tx_dropped: 0,
        },
      },
    });

    const container2Stats2 = createMockStats({
      networks: {
        eth0: {
          rx_bytes: 1024 * 1024 * 120, // +20 MB
          rx_packets: 1200,
          rx_errors: 0,
          rx_dropped: 0,
          tx_bytes: 1024 * 1024 * 60,
          tx_packets: 600,
          tx_errors: 0,
          tx_dropped: 0,
        },
      },
    });

    const result1 = calculate('container1', 'test1', container1Stats2);
    const result2 = calculate('container2', 'test2', container2Stats2);

    // Container 1: 10 MB/s
    expect(result1.rates.networkRxBytesPerSec).toBeCloseTo(10 * 1024 * 1024, 0);
    // Container 2: 20 MB/s
    expect(result2.rates.networkRxBytesPerSec).toBeCloseTo(20 * 1024 * 1024, 0);
  });

  it('should prevent division by zero for very fast calls', () => {
    const stats1 = createMockStats();
    calculate('container1', 'test-container', stats1);

    // Don't advance time - immediate second call
    const stats2 = createMockStats();
    const result = calculate('container1', 'test-container', stats2);

    // Should return safe zero values instead of Infinity or NaN
    expect(result.rates.cpuPercent).toBe(0);
    expect(result.rates.networkRxBytesPerSec).toBe(0);
  });

  it('should handle case-insensitive block IO op names', () => {
    const stats1 = createMockStats({
      blkio_stats: {
        io_service_bytes_recursive: [
          { major: 8, minor: 0, op: 'Read', value: 1024 * 1024 * 100 }, // Capital R
          { major: 8, minor: 0, op: 'Write', value: 1024 * 1024 * 50 }, // Capital W
        ],
        io_serviced_recursive: [],
        io_queue_recursive: [],
        io_service_time_recursive: [],
        io_wait_time_recursive: [],
        io_merged_recursive: [],
        io_time_recursive: [],
        sectors_recursive: [],
      },
    });

    calculate('container1', 'test-container', stats1);
    jest.advanceTimersByTime(1000);

    const stats2 = createMockStats({
      blkio_stats: {
        io_service_bytes_recursive: [
          { major: 8, minor: 0, op: 'Read', value: 1024 * 1024 * 110 },
          { major: 8, minor: 0, op: 'Write', value: 1024 * 1024 * 55 },
        ],
        io_serviced_recursive: [],
        io_queue_recursive: [],
        io_service_time_recursive: [],
        io_wait_time_recursive: [],
        io_merged_recursive: [],
        io_time_recursive: [],
        sectors_recursive: [],
      },
    });

    const result = calculate('container1', 'test-container', stats2);

    expect(result.rates.blockIoReadBytesPerSec).toBeCloseTo(10 * 1024 * 1024, 0);
    expect(result.rates.blockIoWriteBytesPerSec).toBeCloseTo(5 * 1024 * 1024, 0);
  });
});

describe('DockerRateCalculator.clear', () => {
  beforeEach(() => {
    calculator = new DockerRateCalculator();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should clear all cached data', () => {
    const stats = createMockStats();

    // Add some containers to cache
    calculate('container1', 'test1', stats);
    calculate('container2', 'test2', stats);

    // Clear cache
    calculator.clear();

    jest.advanceTimersByTime(1000);

    // Next calls should act as first calls (no previous data)
    const result1 = calculate('container1', 'test1', createMockStats());
    const result2 = calculate('container2', 'test2', createMockStats());

    expect(result1.rates.cpuPercent).toBe(0);
    expect(result2.rates.cpuPercent).toBe(0);
  });
});

describe('DockerRateCalculator.remove', () => {
  beforeEach(() => {
    calculator = new DockerRateCalculator();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should remove specific container from cache', () => {
    const stats = createMockStats();

    calculate('container1', 'test1', stats);
    calculate('container2', 'test2', stats);

    // Remove only container1
    calculator.remove('container1');

    jest.advanceTimersByTime(1000);

    const result1 = calculate('container1', 'test1', createMockStats());
    const result2 = calculate('container2', 'test2', createMockStats({
      networks: {
        eth0: {
          rx_bytes: 1024 * 1024 * 110,
          rx_packets: 1100,
          rx_errors: 0,
          rx_dropped: 0,
          tx_bytes: 1024 * 1024 * 55,
          tx_packets: 550,
          tx_errors: 0,
          tx_dropped: 0,
        },
      },
    }));

    // Container1 should have no previous data
    expect(result1.rates.cpuPercent).toBe(0);

    // Container2 should still have previous data and calculate rates
    expect(result2.rates.networkRxBytesPerSec).toBeGreaterThan(0);
  });
});
