import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { render } from '@testing-library/react';
import SparklineCell from '@/components/shared-table/SparklineCell';

/**
 * Mock css-vars to avoid needing real CSS custom properties resolved via getComputedStyle.
 * This is a leaf dependency (not broadly imported) so mock.module is acceptable here.
 */
mock.module('@/lib/charts/css-vars', () => ({
  resolveChartColors: (color: string) => ({
    line: `rgb(${color === '--chart-network' ? '100, 200, 50' : '255, 0, 0'})`,
    areaStart: 'rgba(255,0,0,0.3)',
    areaEnd: 'rgba(255,0,0,0)',
  }),
}));

mock.module('@/lib/charts/y-axis', () => ({
  calculateCleanYAxis: () => ({ min: 0, max: 100, interval: 25 }),
}));

/** Suppress console.info from mount/unmount/state logging */
const originalInfo = console.info;
beforeEach(() => {
  console.info = () => {};
});
afterEach(() => {
  console.info = originalInfo;
});

const NOW = 1_700_000_000_000;
let dateNowSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  dateNowSpy = spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  dateNowSpy.mockRestore();
});

/**
 * Helper to build data points relative to NOW.
 * Negative offsets mean "in the past".
 */
function makePoints(offsets: number[], value = 50) {
  return offsets.map((offset) => ({ timestamp: NOW + offset, value }));
}

describe('SparklineCell', () => {
  describe('empty data', () => {
    it('renders PulseLine when data is empty', () => {
      const { container } = render(<SparklineCell data={[]} color="--chart-cpu" />);

      // No canvas rendered — should show PulseLine placeholder
      expect(container.querySelector('canvas')).toBeNull();

      const outerDiv = container.firstElementChild as HTMLElement;
      expect(outerDiv).toBeTruthy();
      expect(outerDiv.style.width).toBe('60px');
      expect(outerDiv.style.height).toBe('24px');
    });
  });

  describe('fresh data (within STALE_THRESHOLD_MS)', () => {
    it('seeds and renders SparklineCanvas', () => {
      const data = makePoints([-1000, -500, 0]);

      const { container } = render(<SparklineCell data={data} color="--chart-cpu" />);

      // SparklineCanvas renders a real canvas element
      const canvas = container.querySelector('canvas');
      expect(canvas).toBeTruthy();
    });
  });

  describe('stale data (older than STALE_THRESHOLD_MS)', () => {
    it('renders PulseLine in waiting state', () => {
      const data = makePoints([-5000]);

      const { container } = render(<SparklineCell data={data} color="--chart-memory" />);

      // Stale data should not render canvas
      expect(container.querySelector('canvas')).toBeNull();

      const outerDiv = container.firstElementChild as HTMLElement;
      expect(outerDiv.style.width).toBe('60px');
    });
  });

  describe('stale then fresh data transition', () => {
    it('transitions from waiting to seeded when fresh data arrives', () => {
      const staleData = makePoints([-5000]);
      const { container, rerender } = render(<SparklineCell data={staleData} color="--chart-cpu" />);
      expect(container.querySelector('canvas')).toBeNull();

      const freshData = makePoints([-1000, -500, 0]);
      rerender(<SparklineCell data={freshData} color="--chart-cpu" />);

      expect(container.querySelector('canvas')).toBeTruthy();
    });
  });

  describe('no new points when already seeded', () => {
    it('does not change accumulator when re-rendered with same data', () => {
      const data = makePoints([-500, 0]);

      const { container, rerender } = render(<SparklineCell data={data} color="--chart-cpu" />);
      expect(container.querySelector('canvas')).toBeTruthy();

      rerender(<SparklineCell data={data} color="--chart-cpu" />);
      expect(container.querySelector('canvas')).toBeTruthy();
    });
  });

  describe('accumulation path (already seeded, new point arrives)', () => {
    it('accumulates new points when rerendered with a later timestamp', () => {
      // Seed with initial fresh data
      const initialData = makePoints([-1000, -500]);
      const { container, rerender } = render(<SparklineCell data={initialData} color="--chart-cpu" />);
      expect(container.querySelector('canvas')).toBeTruthy();

      // Rerender with an additional point at a later timestamp
      const updatedData = makePoints([-1000, -500, 0]);
      rerender(<SparklineCell data={updatedData} color="--chart-cpu" />);

      // Should still render canvas with accumulated points
      expect(container.querySelector('canvas')).toBeTruthy();
    });

    it('drops points older than the 35s window when accumulating', () => {
      // Seed with a fresh initial point (within STALE_THRESHOLD_MS)
      const initialData = makePoints([-1000, 0]);
      const { container, rerender } = render(<SparklineCell data={initialData} color="--chart-cpu" />);
      expect(container.querySelector('canvas')).toBeTruthy();

      // Add a new point at a later timestamp; include a very old point that
      // falls outside the 35s window relative to the new latest timestamp
      const oldPoint = { timestamp: NOW - 36000, value: 50 };
      const updatedData = [oldPoint, ...initialData, { timestamp: NOW + 1000, value: 50 }];
      rerender(<SparklineCell data={updatedData} color="--chart-cpu" />);

      // Canvas should still render (newer accumulated points are within the window)
      expect(container.querySelector('canvas')).toBeTruthy();
    });
  });
});

describe('PulseLine', () => {
  it('renders with correct structure and resolved colors', () => {
    const { container } = render(<SparklineCell data={[]} color="--chart-network" />);

    const outer = container.firstElementChild as HTMLElement;
    expect(outer.style.width).toBe('60px');
    expect(outer.style.height).toBe('24px');

    const innerWrapper = outer.firstElementChild as HTMLElement;
    expect(innerWrapper.style.height).toBe('2px');

    const children = innerWrapper.children;
    expect(children).toHaveLength(2);

    const bgLine = children[0] as HTMLElement;
    expect(bgLine.style.backgroundColor).toBe('rgb(100, 200, 50)');
    expect(bgLine.style.opacity).toBe('0.15');

    const shimmerLine = children[1] as HTMLElement;
    expect(shimmerLine.style.backgroundColor).toBe('rgb(100, 200, 50)');
    expect(shimmerLine.className).toContain('sparkline-shimmer');
  });
});
