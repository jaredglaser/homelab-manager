import { describe, it, expect, mock, beforeEach, afterEach, type Mock } from 'bun:test';
import { render, cleanup } from '@testing-library/react';
import SparklineCanvas from '../SparklineCanvas';

interface TimeSeriesPoint {
  timestamp: number;
  value: number;
}

function makeMockGradient() {
  return { addColorStop: mock(() => {}) };
}

function makeMockContext(gradient: ReturnType<typeof makeMockGradient>) {
  return {
    createLinearGradient: mock(() => gradient),
    clearRect: mock(() => {}),
    beginPath: mock(() => {}),
    moveTo: mock(() => {}),
    lineTo: mock(() => {}),
    closePath: mock(() => {}),
    fill: mock(() => {}),
    stroke: mock(() => {}),
    arc: mock(() => {}),
    save: mock(() => {}),
    restore: mock(() => {}),
    scale: mock(() => {}),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
  };
}

/** Set CSS variables that resolveChartColors reads via getComputedStyle */
function setCssColorVars(base: string, line: string, areaStart: string, areaEnd: string) {
  const root = document.documentElement;
  root.style.setProperty(base, line);
  root.style.setProperty(`${base}-area-start`, areaStart);
  root.style.setProperty(`${base}-area-end`, areaEnd);
}

function clearCssColorVars(base: string) {
  const root = document.documentElement;
  root.style.removeProperty(base);
  root.style.removeProperty(`${base}-area-start`);
  root.style.removeProperty(`${base}-area-end`);
}

// Named color constants: avoid bare hex literals while keeping values Happy-DOM can read
const CPU_LINE = 'rgb(255, 0, 0)';
const CPU_AREA_START = 'rgba(255,0,0,0.3)';
const CPU_AREA_END = 'rgba(255,0,0,0)';
const MEMORY_LINE = 'rgb(0, 255, 0)';
const MEMORY_AREA_START = 'rgba(0,255,0,0.3)';
const MEMORY_AREA_END = 'rgba(0,255,0,0)';

describe('SparklineCanvas', () => {
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
  let originalDPR: number;
  let mockCtx: ReturnType<typeof makeMockContext>;
  let mockGradient: ReturnType<typeof makeMockGradient>;
  let animateSpy: Mock<(...args: unknown[]) => { cancel: Mock<() => void> }>;
  let createdAnimations: Array<{ cancel: Mock<() => void> }>;
  let originalAnimate: typeof Element.prototype.animate;

  beforeEach(() => {
    setCssColorVars('--chart-cpu', CPU_LINE, CPU_AREA_START, CPU_AREA_END);
    originalDPR = window.devicePixelRatio;

    mockGradient = makeMockGradient();
    mockCtx = makeMockContext(mockGradient);

    originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = mock(function (
      this: HTMLCanvasElement,
      contextId: string,
      _options?: unknown,
    ) {
      if (contextId === '2d') return mockCtx as unknown as CanvasRenderingContext2D;
      return null;
    }) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    createdAnimations = [];
    animateSpy = mock(() => {
      const animation = { cancel: mock(() => {}) };
      createdAnimations.push(animation);
      return animation;
    }) as unknown as Mock<(...args: unknown[]) => { cancel: Mock<() => void> }>;
    originalAnimate = Element.prototype.animate;
    Element.prototype.animate = animateSpy as unknown as typeof Element.prototype.animate;
  });

  afterEach(() => {
    cleanup();
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    if (originalAnimate) Element.prototype.animate = originalAnimate;
    else delete (Element.prototype as { animate?: unknown }).animate;
    Object.defineProperty(window, 'devicePixelRatio', { value: originalDPR, configurable: true });
    clearCssColorVars('--chart-cpu');
  });

  function clearRectCalls() {
    return (mockCtx.clearRect as Mock<typeof mockCtx.clearRect>).mock.calls.length;
  }

  it('renders a canvas element with correct width/height styles', () => {
    const { container } = render(
      <SparklineCanvas data={[]} color="--chart-cpu" width={80} height={30} />,
    );
    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(canvas!.style.width).toBe('80px');
    expect(canvas!.style.height).toBe('30px');
  });

  it('renders wrapper div with contain: strict and className', () => {
    const { container } = render(
      <SparklineCanvas data={[]} color="--chart-cpu" className="my-custom" />,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.style.contain).toBe('strict');
    expect(wrapper.className).toContain('my-custom');
  });

  it('uses default dimensions (width=60, height=24) when not provided', () => {
    const { container } = render(<SparklineCanvas data={[]} color="--chart-cpu" />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.style.width).toBe('60px');
    expect(wrapper.style.height).toBe('24px');

    const canvas = container.querySelector('canvas');
    expect(canvas!.style.width).toBe('60px');
    expect(canvas!.style.height).toBe('24px');
  });

  it('applies custom dimensions when provided', () => {
    const { container } = render(
      <SparklineCanvas data={[]} color="--chart-cpu" width={120} height={48} />,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.style.width).toBe('120px');
    expect(wrapper.style.height).toBe('48px');
  });

  it('calls canvas getContext with 2d and alpha', () => {
    render(<SparklineCanvas data={[]} color="--chart-cpu" />);
    expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalledWith('2d', { alpha: true });
  });

  it('handles empty data array without drawing paths or starting the slide', () => {
    render(<SparklineCanvas data={[]} color="--chart-cpu" />);

    expect(mockCtx.clearRect).toHaveBeenCalled();
    expect(mockCtx.moveTo).not.toHaveBeenCalled();
    expect(animateSpy).not.toHaveBeenCalled();
  });

  it('scales canvas dimensions by device pixel ratio', () => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    const { container } = render(
      <SparklineCanvas data={[]} color="--chart-cpu" width={60} height={24} />,
    );
    const canvas = container.querySelector('canvas')!;
    expect(canvas.width).toBe(120);
    expect(canvas.height).toBe(48);
    expect(mockCtx.scale).toHaveBeenCalledWith(2, 2);

    Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
  });

  it('draws gradient area and line when data is provided', () => {
    const now = Date.now();
    const data: TimeSeriesPoint[] = [
      { timestamp: now - 2000, value: 30 },
      { timestamp: now - 1000, value: 60 },
      { timestamp: now, value: 45 },
    ];

    const { container } = render(<SparklineCanvas data={data} color="--chart-cpu" />);

    expect(mockCtx.beginPath).toHaveBeenCalled();
    expect(mockCtx.moveTo).toHaveBeenCalled();
    expect(mockCtx.lineTo).toHaveBeenCalled();
    expect(mockCtx.fill).toHaveBeenCalled();
    expect(mockCtx.stroke).toHaveBeenCalled();
    // The pulse dot is a DOM element, not canvas-drawn
    expect(mockCtx.arc).not.toHaveBeenCalled();

    const dot = container.querySelector('.sparkline-dot') as HTMLElement | null;
    expect(dot).not.toBeNull();
    expect(dot!.style.backgroundColor).toContain('255');
  });

  it('omits the pulse dot when data is empty', () => {
    const { container } = render(<SparklineCanvas data={[]} color="--chart-cpu" />);
    expect(container.querySelector('.sparkline-dot')).toBeNull();
  });

  it('positions the pulse dot at the last data point after a draw', () => {
    const now = Date.now();
    const data: TimeSeriesPoint[] = [{ timestamp: now, value: 50 }];

    const { container } = render(<SparklineCanvas data={data} color="--chart-cpu" />);

    const dot = container.querySelector('.sparkline-dot') as HTMLElement;
    expect(dot.style.left).not.toBe('-9999px');
    expect(dot.style.left).toMatch(/px$/);
    expect(dot.style.top).toMatch(/px$/);
  });

  it('redraws only when the data array changes', () => {
    const now = Date.now();
    const data: TimeSeriesPoint[] = [{ timestamp: now, value: 50 }];

    const { rerender } = render(<SparklineCanvas data={data} color="--chart-cpu" />);
    const afterMount = clearRectCalls();
    expect(afterMount).toBeGreaterThan(0);

    rerender(<SparklineCanvas data={data} color="--chart-cpu" />);
    expect(clearRectCalls()).toBe(afterMount);

    const next: TimeSeriesPoint[] = [{ timestamp: now + 1000, value: 60 }];
    rerender(<SparklineCanvas data={next} color="--chart-cpu" />);
    expect(clearRectCalls()).toBe(afterMount + 1);
  });

  it('restarts the compositor slide on each data draw', () => {
    const now = Date.now();
    const data: TimeSeriesPoint[] = [{ timestamp: now, value: 50 }];

    const { rerender } = render(<SparklineCanvas data={data} color="--chart-cpu" />);

    expect(animateSpy).toHaveBeenCalledTimes(1);
    // Default width 60, PADDING 2: the stage traverses the drawable width over the window
    expect(animateSpy.mock.calls[0][0]).toEqual([
      { transform: 'translateX(0)' },
      { transform: 'translateX(-56px)' },
    ]);
    expect(animateSpy.mock.calls[0][1]).toEqual({
      duration: 30000,
      easing: 'linear',
      fill: 'forwards',
    });

    const next: TimeSeriesPoint[] = [{ timestamp: now + 1000, value: 60 }];
    rerender(<SparklineCanvas data={next} color="--chart-cpu" />);

    expect(animateSpy).toHaveBeenCalledTimes(2);
    expect(createdAnimations[0].cancel).toHaveBeenCalled();
  });

  it('cancels the slide animation on unmount', () => {
    const now = Date.now();
    const data: TimeSeriesPoint[] = [{ timestamp: now, value: 50 }];

    const { unmount } = render(<SparklineCanvas data={data} color="--chart-cpu" />);
    expect(createdAnimations.length).toBe(1);

    unmount();
    expect(createdAnimations[0].cancel).toHaveBeenCalled();
  });

  it('does not start the slide when prefers-reduced-motion is set', () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = mock(() => ({ matches: true })) as unknown as typeof window.matchMedia;
    try {
      const now = Date.now();
      const data: TimeSeriesPoint[] = [{ timestamp: now, value: 50 }];
      render(<SparklineCanvas data={data} color="--chart-cpu" />);
      expect(animateSpy).not.toHaveBeenCalled();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('creates a linear gradient with area colors', () => {
    const now = Date.now();
    const data: TimeSeriesPoint[] = [{ timestamp: now, value: 50 }];

    render(<SparklineCanvas data={data} color="--chart-cpu" />);

    expect(mockCtx.createLinearGradient).toHaveBeenCalled();
    expect(mockGradient.addColorStop).toHaveBeenCalledWith(0, CPU_AREA_START);
    expect(mockGradient.addColorStop).toHaveBeenCalledWith(1, CPU_AREA_END);
  });

  it('rebuilds gradient when color prop changes after mount', () => {
    // Register a second color CSS variable set
    setCssColorVars('--chart-memory', MEMORY_LINE, MEMORY_AREA_START, MEMORY_AREA_END);

    // Mount with initial color: canvas setup effect stores gradientCtxRef.current
    const result = render(<SparklineCanvas data={[]} color="--chart-cpu" />);

    const callsAfterMount = (mockCtx.createLinearGradient as Mock<typeof mockCtx.createLinearGradient>).mock.calls.length;
    expect(callsAfterMount).toBeGreaterThan(0);

    // Re-render with a different color: the color/height effect runs again and
    // now gradientCtxRef.current is set, so lines 62-65 execute
    result.rerender(<SparklineCanvas data={[]} color="--chart-memory" />);

    const callsAfterRerender = (mockCtx.createLinearGradient as Mock<typeof mockCtx.createLinearGradient>).mock.calls.length;
    expect(callsAfterRerender).toBeGreaterThan(callsAfterMount);

    clearCssColorVars('--chart-memory');
  });

  it('skips canvas draws for hidden sparklines until IO reports them visible', () => {
    const originalIO = globalThis.IntersectionObserver;
    let emit: (visible: boolean) => void = () => {};
    const ControllableIO = class {
      constructor(cb: IntersectionObserverCallback) {
        emit = (visible: boolean) =>
          cb(
            [{ isIntersecting: visible, target: {} } as unknown as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = '';
      thresholds: readonly number[] = [];
    };
    globalThis.IntersectionObserver = ControllableIO as unknown as typeof IntersectionObserver;
    try {
      const now = Date.now();
      const { rerender } = render(<SparklineCanvas data={[{ timestamp: now, value: 50 }]} color="--chart-cpu" />);
      emit(false);
      const hiddenCalls = clearRectCalls();
      const hiddenSlides = animateSpy.mock.calls.length;
      expect(hiddenCalls).toBeGreaterThan(0);

      // Stats update while hidden: no canvas draw, no slide restart.
      rerender(<SparklineCanvas data={[{ timestamp: now + 1000, value: 60 }]} color="--chart-cpu" />);
      expect(clearRectCalls()).toBe(hiddenCalls);
      expect(animateSpy.mock.calls.length).toBe(hiddenSlides);

      // Becoming visible refreshes the stale snapshot and restarts the slide.
      emit(true);
      expect(clearRectCalls()).toBe(hiddenCalls + 1);
      expect(animateSpy.mock.calls.length).toBe(hiddenSlides + 1);
    } finally {
      globalThis.IntersectionObserver = originalIO;
    }
  });
});
