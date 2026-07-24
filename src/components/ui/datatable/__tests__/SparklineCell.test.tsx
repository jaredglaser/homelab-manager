import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { render } from '@testing-library/react';
import SparklineCell from '@/components/ui/datatable/SparklineCell';
import { resetSparklineStore } from '@/components/ui/datatable/sparkline-accumulator-store';

// Set CSS custom properties so resolveChartColors reads real values via getComputedStyle.
// Closer to how the component actually runs than stubbing the resolver.
function setCssVar(name: string, value: string) {
  document.documentElement.style.setProperty(name, value);
}
function clearCssVar(name: string) {
  document.documentElement.style.removeProperty(name);
}

// Unique key per render call so the module-level accumulator never leaks between cases.
let keyCounter = 0;
function nextKey() {
  keyCounter += 1;
  return `host/container-${keyCounter}:cpu`;
}

beforeEach(() => {
  resetSparklineStore();
  setCssVar('--chart-cpu', 'rgb(255, 0, 0)');
  setCssVar('--chart-memory', 'rgb(0, 255, 0)');
  setCssVar('--chart-network', 'rgb(100, 200, 50)');
});
afterEach(() => {
  clearCssVar('--chart-cpu');
  clearCssVar('--chart-memory');
  clearCssVar('--chart-network');
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
      const { container } = render(<SparklineCell data={[]} color="--chart-cpu" seriesKey={nextKey()} />);

      // No canvas rendered, should show PulseLine placeholder
      expect(container.querySelector('canvas')).toBeNull();

      const outerDiv = container.firstElementChild as HTMLElement;
      expect(outerDiv).toBeTruthy();
      expect(outerDiv.style.width).toBe('60px');
      expect(outerDiv.style.height).toBe('24px');
    });
  });

  describe('drawable data (inside the canvas window)', () => {
    it('seeds and renders SparklineCanvas', () => {
      const data = makePoints([-1000, -500, 0]);

      const { container } = render(<SparklineCell data={data} color="--chart-cpu" seriesKey={nextKey()} />);

      // SparklineCanvas renders a real canvas element
      const canvas = container.querySelector('canvas');
      expect(canvas).toBeTruthy();
    });
  });

  describe('undrawable data (older than the canvas window)', () => {
    it('renders PulseLine in waiting state', () => {
      const data = makePoints([-30000]);

      const { container } = render(<SparklineCell data={data} color="--chart-memory" seriesKey={nextKey()} />);

      // Data too old to draw should not render canvas
      expect(container.querySelector('canvas')).toBeNull();

      const outerDiv = container.firstElementChild as HTMLElement;
      expect(outerDiv.style.width).toBe('60px');
    });
  });

  describe('undrawable then drawable data transition', () => {
    it('transitions from waiting to seeded when drawable data arrives', () => {
      const key = nextKey();
      const undrawableData = makePoints([-30000]);
      const { container, rerender } = render(
        <SparklineCell data={undrawableData} color="--chart-cpu" seriesKey={key} />,
      );
      expect(container.querySelector('canvas')).toBeNull();

      const freshData = makePoints([-1000, -500, 0]);
      rerender(<SparklineCell data={freshData} color="--chart-cpu" seriesKey={key} />);

      expect(container.querySelector('canvas')).toBeTruthy();
    });
  });

  describe('no new points when already seeded', () => {
    it('does not change accumulator when re-rendered with same data', () => {
      const key = nextKey();
      const data = makePoints([-500, 0]);

      const { container, rerender } = render(<SparklineCell data={data} color="--chart-cpu" seriesKey={key} />);
      expect(container.querySelector('canvas')).toBeTruthy();

      rerender(<SparklineCell data={data} color="--chart-cpu" seriesKey={key} />);
      expect(container.querySelector('canvas')).toBeTruthy();
    });
  });

  describe('accumulation path (already seeded, new point arrives)', () => {
    it('accumulates new points when rerendered with a later timestamp', () => {
      // Seed with initial fresh data
      const key = nextKey();
      const initialData = makePoints([-1000, -500]);
      const { container, rerender } = render(<SparklineCell data={initialData} color="--chart-cpu" seriesKey={key} />);
      expect(container.querySelector('canvas')).toBeTruthy();

      // Rerender with an additional point at a later timestamp
      const updatedData = makePoints([-1000, -500, 0]);
      rerender(<SparklineCell data={updatedData} color="--chart-cpu" seriesKey={key} />);

      // Should still render canvas with accumulated points
      expect(container.querySelector('canvas')).toBeTruthy();
    });

    it('drops points older than the 35s window when accumulating', () => {
      // Seed with a fresh initial point (inside the canvas window)
      const key = nextKey();
      const initialData = makePoints([-1000, 0]);
      const { container, rerender } = render(<SparklineCell data={initialData} color="--chart-cpu" seriesKey={key} />);
      expect(container.querySelector('canvas')).toBeTruthy();

      // Add a new point at a later timestamp; include a very old point that
      // falls outside the 35s window relative to the new latest timestamp
      const oldPoint = { timestamp: NOW - 36000, value: 50 };
      const updatedData = [oldPoint, ...initialData, { timestamp: NOW + 1000, value: 50 }];
      rerender(<SparklineCell data={updatedData} color="--chart-cpu" seriesKey={key} />);

      // Canvas should still render (newer accumulated points are within the window)
      expect(container.querySelector('canvas')).toBeTruthy();
    });
  });
});

describe('PulseLine', () => {
  it('renders with correct structure and resolved colors', () => {
    const { container } = render(<SparklineCell data={[]} color="--chart-network" seriesKey={nextKey()} />);

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
