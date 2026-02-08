import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { ZFSIOStatWithRates } from '@/types/zfs';

// Mock the useSSE hook
let mockOnData: ((data: ZFSIOStatWithRates[]) => void) | null = null;
let mockIsConnected = false;
let mockError: Error | null = null;

mock.module('@/hooks/useSSE', () => ({
  useSSE: <T>({ onData }: { url: string; onData: (data: T) => void }) => {
    mockOnData = onData as (data: ZFSIOStatWithRates[]) => void;
    return { isConnected: mockIsConnected, error: mockError };
  },
}));

// Import after mocking
const { useTimeSeriesBuffer } = await import('../useTimeSeriesBuffer');

// Helper to create mock ZFS stats
function createMockStat(
  name: string,
  indent: number,
  readBytesPerSec: number = 1024,
  writeBytesPerSec: number = 512
): ZFSIOStatWithRates {
  return {
    name,
    indent,
    id: name,
    timestamp: Date.now(),
    capacity: { alloc: 1000, free: 2000 },
    operations: { read: 10, write: 5 },
    bandwidth: { read: 1024, write: 512 },
    total: { readOps: 100, writeOps: 50, readBytes: 10240, writeBytes: 5120 },
    rates: {
      readOpsPerSec: 10,
      writeOpsPerSec: 5,
      readBytesPerSec,
      writeBytesPerSec,
      utilizationPercent: 33.33,
    },
  };
}

// Mock useState and useCallback for testing outside React
let currentPoolsData = new Map();
const mockSetPoolsData = (
  updater:
    | Map<string, unknown>
    | ((prev: Map<string, unknown>) => Map<string, unknown>)
) => {
  if (typeof updater === 'function') {
    currentPoolsData = updater(currentPoolsData);
  } else {
    currentPoolsData = updater;
  }
};

// Mock ref to track if initial data was loaded
const mockRefs = new Map<string, { current: unknown }>();

mock.module('react', () => ({
  useState: (initial: unknown) => {
    if (currentPoolsData.size === 0 && initial instanceof Map) {
      currentPoolsData = initial;
    }
    return [currentPoolsData, mockSetPoolsData];
  },
  useCallback: (fn: unknown) => fn,
  useRef: (initial: unknown) => {
    // Create a stable ref per initial value type
    const key = typeof initial;
    if (!mockRefs.has(key)) {
      mockRefs.set(key, { current: initial });
    }
    return mockRefs.get(key)!;
  },
  useEffect: (fn: () => void | (() => void)) => {
    // Run effect immediately for testing
    fn();
  },
}));

describe('useTimeSeriesBuffer', () => {
  beforeEach(() => {
    currentPoolsData = new Map();
    mockOnData = null;
    mockIsConnected = false;
    mockError = null;
    mockRefs.clear();
  });

  it('should initialize with empty pools data', () => {
    const result = useTimeSeriesBuffer('/api/zfs-stats');
    expect(result.poolsData.size).toBe(0);
  });

  it('should filter to only pool-level entities (indent === 0)', () => {
    useTimeSeriesBuffer('/api/zfs-stats');

    const stats = [
      createMockStat('tank', 0), // Pool - should be included
      createMockStat('mirror-0', 2), // Vdev - should be excluded
      createMockStat('sda', 4), // Disk - should be excluded
    ];

    mockOnData?.(stats);

    expect(currentPoolsData.size).toBe(1);
    expect(currentPoolsData.has('tank')).toBe(true);
    expect(currentPoolsData.has('mirror-0')).toBe(false);
    expect(currentPoolsData.has('sda')).toBe(false);
  });

  it('should add data points with correct values', () => {
    useTimeSeriesBuffer('/api/zfs-stats');

    const stats = [createMockStat('tank', 0, 2048, 1024)];

    mockOnData?.(stats);

    const poolData = currentPoolsData.get('tank');
    expect(poolData).toBeDefined();
    expect(poolData.poolName).toBe('tank');
    expect(poolData.dataPoints.length).toBe(1);
    expect(poolData.dataPoints[0].readBytesPerSec).toBe(2048);
    expect(poolData.dataPoints[0].writeBytesPerSec).toBe(1024);
    expect(typeof poolData.dataPoints[0].timestamp).toBe('number');
  });

  it('should accumulate data points over multiple updates', () => {
    useTimeSeriesBuffer('/api/zfs-stats');

    mockOnData?.([createMockStat('tank', 0, 1000, 500)]);
    mockOnData?.([createMockStat('tank', 0, 2000, 1000)]);
    mockOnData?.([createMockStat('tank', 0, 3000, 1500)]);

    const poolData = currentPoolsData.get('tank');
    expect(poolData.dataPoints.length).toBe(3);
    expect(poolData.dataPoints[0].readBytesPerSec).toBe(1000);
    expect(poolData.dataPoints[1].readBytesPerSec).toBe(2000);
    expect(poolData.dataPoints[2].readBytesPerSec).toBe(3000);
  });

  it('should limit buffer to 60 data points', () => {
    useTimeSeriesBuffer('/api/zfs-stats');

    // Add 65 data points
    for (let i = 0; i < 65; i++) {
      mockOnData?.([createMockStat('tank', 0, i * 100, i * 50)]);
    }

    const poolData = currentPoolsData.get('tank');
    expect(poolData.dataPoints.length).toBe(60);

    // First 5 points should have been removed (shifted out)
    // So first remaining point should have readBytesPerSec = 500 (index 5 * 100)
    expect(poolData.dataPoints[0].readBytesPerSec).toBe(500);
    // Last point should have readBytesPerSec = 6400 (index 64 * 100)
    expect(poolData.dataPoints[59].readBytesPerSec).toBe(6400);
  });

  it('should handle multiple pools', () => {
    useTimeSeriesBuffer('/api/zfs-stats');

    const stats = [
      createMockStat('tank', 0, 1000, 500),
      createMockStat('backup', 0, 2000, 1000),
    ];

    mockOnData?.(stats);

    expect(currentPoolsData.size).toBe(2);
    expect(currentPoolsData.has('tank')).toBe(true);
    expect(currentPoolsData.has('backup')).toBe(true);

    const tankData = currentPoolsData.get('tank');
    const backupData = currentPoolsData.get('backup');

    expect(tankData.dataPoints[0].readBytesPerSec).toBe(1000);
    expect(backupData.dataPoints[0].readBytesPerSec).toBe(2000);
  });

  it('should remove pools that no longer exist', () => {
    useTimeSeriesBuffer('/api/zfs-stats');

    // First update with two pools
    mockOnData?.([
      createMockStat('tank', 0),
      createMockStat('backup', 0),
    ]);

    expect(currentPoolsData.size).toBe(2);

    // Second update with only one pool
    mockOnData?.([createMockStat('tank', 0)]);

    expect(currentPoolsData.size).toBe(1);
    expect(currentPoolsData.has('tank')).toBe(true);
    expect(currentPoolsData.has('backup')).toBe(false);
  });

  it('should add new pools dynamically', () => {
    useTimeSeriesBuffer('/api/zfs-stats');

    // First update with one pool
    mockOnData?.([createMockStat('tank', 0)]);

    expect(currentPoolsData.size).toBe(1);

    // Second update with additional pool
    mockOnData?.([
      createMockStat('tank', 0),
      createMockStat('newpool', 0),
    ]);

    expect(currentPoolsData.size).toBe(2);
    expect(currentPoolsData.has('newpool')).toBe(true);
  });

  it('should return connection status from useSSE', () => {
    mockIsConnected = true;
    const result = useTimeSeriesBuffer('/api/zfs-stats');
    expect(result.isConnected).toBe(true);
  });

  it('should return error from useSSE', () => {
    mockError = new Error('Connection failed');
    const result = useTimeSeriesBuffer('/api/zfs-stats');
    expect(result.error?.message).toBe('Connection failed');
  });

  it('should handle empty stats array', () => {
    useTimeSeriesBuffer('/api/zfs-stats');

    // Add a pool first
    mockOnData?.([createMockStat('tank', 0)]);
    expect(currentPoolsData.size).toBe(1);

    // Send empty array - all pools should be removed
    mockOnData?.([]);
    expect(currentPoolsData.size).toBe(0);
  });

  it('should preserve existing data points when pool continues to exist', () => {
    useTimeSeriesBuffer('/api/zfs-stats');

    mockOnData?.([createMockStat('tank', 0, 1000, 500)]);
    mockOnData?.([createMockStat('tank', 0, 2000, 1000)]);

    const poolData = currentPoolsData.get('tank');
    expect(poolData.dataPoints.length).toBe(2);
    expect(poolData.dataPoints[0].readBytesPerSec).toBe(1000);
    expect(poolData.dataPoints[1].readBytesPerSec).toBe(2000);
  });

  describe('fetchInitialData', () => {
    it('should load initial data when provided', async () => {
      const initialData = [
        {
          poolName: 'tank',
          dataPoints: [
            { timestamp: 1000, readBytesPerSec: 100, writeBytesPerSec: 50 },
            { timestamp: 2000, readBytesPerSec: 200, writeBytesPerSec: 100 },
          ],
        },
      ];

      useTimeSeriesBuffer({
        sseUrl: '/api/zfs-stats',
        fetchInitialData: () => Promise.resolve(initialData),
      });

      // Wait for the promise to resolve
      await new Promise(resolve => setTimeout(resolve, 10));

      const poolData = currentPoolsData.get('tank');
      expect(poolData).toBeDefined();
      expect(poolData.dataPoints.length).toBe(2);
      expect(poolData.dataPoints[0].readBytesPerSec).toBe(100);
      expect(poolData.dataPoints[1].readBytesPerSec).toBe(200);
    });

    it('should handle empty initial data', async () => {
      useTimeSeriesBuffer({
        sseUrl: '/api/zfs-stats',
        fetchInitialData: () => Promise.resolve([]),
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(currentPoolsData.size).toBe(0);
    });

    it('should handle null initial data', async () => {
      useTimeSeriesBuffer({
        sseUrl: '/api/zfs-stats',
        fetchInitialData: () => Promise.resolve(null as unknown as []),
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(currentPoolsData.size).toBe(0);
    });

    it('should limit initial data to MAX_DATA_POINTS', async () => {
      const manyPoints = Array.from({ length: 100 }, (_, i) => ({
        timestamp: i * 1000,
        readBytesPerSec: i * 10,
        writeBytesPerSec: i * 5,
      }));

      useTimeSeriesBuffer({
        sseUrl: '/api/zfs-stats',
        fetchInitialData: () =>
          Promise.resolve([{ poolName: 'tank', dataPoints: manyPoints }]),
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      const poolData = currentPoolsData.get('tank');
      expect(poolData.dataPoints.length).toBe(60); // MAX_DATA_POINTS
    });

    it('should prepend historical data to existing SSE data', async () => {
      // Pre-populate with existing SSE data to simulate race condition
      const sseTimestamp = Date.now();
      currentPoolsData.set('tank', {
        poolName: 'tank',
        dataPoints: [{ timestamp: sseTimestamp, readBytesPerSec: 5000, writeBytesPerSec: 2500 }],
      });

      useTimeSeriesBuffer({
        sseUrl: '/api/zfs-stats',
        fetchInitialData: () =>
          Promise.resolve([
            {
              poolName: 'tank',
              dataPoints: [
                { timestamp: sseTimestamp - 2000, readBytesPerSec: 100, writeBytesPerSec: 50 },
                { timestamp: sseTimestamp - 1000, readBytesPerSec: 200, writeBytesPerSec: 100 },
              ],
            },
          ]),
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      const poolData = currentPoolsData.get('tank');
      // Should have historical (2) + existing SSE (1) = 3 points
      expect(poolData.dataPoints.length).toBe(3);
      // Historical data should come first
      expect(poolData.dataPoints[0].readBytesPerSec).toBe(100);
      expect(poolData.dataPoints[1].readBytesPerSec).toBe(200);
      // SSE data should be last
      expect(poolData.dataPoints[2].readBytesPerSec).toBe(5000);
    });

    it('should not duplicate overlapping timestamps', async () => {
      const timestamp = Date.now();

      // Add SSE data first
      currentPoolsData.set('tank', {
        poolName: 'tank',
        dataPoints: [{ timestamp, readBytesPerSec: 5000, writeBytesPerSec: 2500 }],
      });

      useTimeSeriesBuffer({
        sseUrl: '/api/zfs-stats',
        fetchInitialData: () =>
          Promise.resolve([
            {
              poolName: 'tank',
              dataPoints: [
                // This timestamp overlaps with existing data
                { timestamp: timestamp + 100, readBytesPerSec: 100, writeBytesPerSec: 50 },
              ],
            },
          ]),
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      const poolData = currentPoolsData.get('tank');
      // Overlapping data should be filtered out
      expect(poolData.dataPoints.length).toBe(1);
    });

    it('should handle fetchInitialData rejection gracefully', async () => {
      const consoleSpy = mock(() => {});
      const originalError = console.error;
      console.error = consoleSpy;

      useTimeSeriesBuffer({
        sseUrl: '/api/zfs-stats',
        fetchInitialData: () => Promise.reject(new Error('Network error')),
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(consoleSpy).toHaveBeenCalled();
      expect(currentPoolsData.size).toBe(0);

      console.error = originalError;
    });

    it('should only load initial data once', async () => {
      let callCount = 0;
      const fetchFn = () => {
        callCount++;
        return Promise.resolve([
          {
            poolName: 'tank',
            dataPoints: [{ timestamp: 1000, readBytesPerSec: 100, writeBytesPerSec: 50 }],
          },
        ]);
      };

      // Reset the ref mock to simulate multiple effect runs
      mockRefs.clear();

      useTimeSeriesBuffer({
        sseUrl: '/api/zfs-stats',
        fetchInitialData: fetchFn,
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      // The ref should prevent multiple calls
      expect(callCount).toBe(1);
    });
  });
});
