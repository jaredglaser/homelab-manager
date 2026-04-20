import { describe, it, expect, mock, beforeEach, afterEach, type Mock } from 'bun:test';
import { render, cleanup, act, type RenderResult } from '@testing-library/react';
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
  let rafSpy: Mock<typeof window.requestAnimationFrame>;
  let cafSpy: Mock<typeof window.cancelAnimationFrame>;
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
  let originalRaf: typeof window.requestAnimationFrame;
  let originalCaf: typeof window.cancelAnimationFrame;
  let originalDPR: number;
  let mockCtx: ReturnType<typeof makeMockContext>;
  let mockGradient: ReturnType<typeof makeMockGradient>;
  let rafCallbacks: FrameRequestCallback[];

  /** Execute the first queued RAF callback (the render loop re-enqueues itself, which we capture but do not recurse into) */
  function flushOneFrame() {
    const cb = rafCallbacks.shift();
    if (cb) act(() => cb(performance.now()));
  }

  beforeEach(() => {
    setCssColorVars('--chart-cpu', CPU_LINE, CPU_AREA_START, CPU_AREA_END);

    originalRaf = window.requestAnimationFrame;
    originalCaf = window.cancelAnimationFrame;
    originalDPR = window.devicePixelRatio;

    rafCallbacks = [];
    let nextId = 1;
    rafSpy = mock((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return nextId++;
    }) as Mock<typeof window.requestAnimationFrame>;
    cafSpy = mock(() => {}) as Mock<typeof window.cancelAnimationFrame>;
    window.requestAnimationFrame = rafSpy;
    window.cancelAnimationFrame = cafSpy;

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
  });

  afterEach(() => {
    cleanup();
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    window.requestAnimationFrame = originalRaf;
    window.cancelAnimationFrame = originalCaf;
    Object.defineProperty(window, 'devicePixelRatio', { value: originalDPR, configurable: true });
    clearCssColorVars('--chart-cpu');
  });

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

  it('cancels animation frame on unmount', () => {
    const { unmount } = render(<SparklineCanvas data={[]} color="--chart-cpu" />);
    unmount();
    expect(cafSpy).toHaveBeenCalled();
  });

  it('calls requestAnimationFrame on mount', () => {
    render(<SparklineCanvas data={[]} color="--chart-cpu" />);
    expect(rafSpy).toHaveBeenCalled();
  });

  it('calls canvas getContext with 2d and alpha', () => {
    render(<SparklineCanvas data={[]} color="--chart-cpu" />);
    expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalledWith('2d', { alpha: true });
  });

  it('handles empty data array without drawing paths', () => {
    render(<SparklineCanvas data={[]} color="--chart-cpu" />);

    // Flush one animation frame so the render callback runs
    flushOneFrame();

    // clearRect is called (canvas is cleared), but no paths are drawn because data is empty
    expect(mockCtx.clearRect).toHaveBeenCalled();
    expect(mockCtx.moveTo).not.toHaveBeenCalled();
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

  it('draws gradient area, line, and dot when data is provided', () => {
    const now = Date.now();
    const data: TimeSeriesPoint[] = [
      { timestamp: now - 2000, value: 30 },
      { timestamp: now - 1000, value: 60 },
      { timestamp: now, value: 45 },
    ];

    render(<SparklineCanvas data={data} color="--chart-cpu" />);

    // Flush one animation frame to trigger the render callback
    flushOneFrame();

    expect(mockCtx.beginPath).toHaveBeenCalled();
    expect(mockCtx.moveTo).toHaveBeenCalled();
    expect(mockCtx.lineTo).toHaveBeenCalled();
    expect(mockCtx.fill).toHaveBeenCalled();
    expect(mockCtx.stroke).toHaveBeenCalled();
    expect(mockCtx.arc).toHaveBeenCalled();
    expect(mockCtx.save).toHaveBeenCalled();
    expect(mockCtx.restore).toHaveBeenCalled();
  });

  it('creates a linear gradient with area colors', () => {
    const now = Date.now();
    const data: TimeSeriesPoint[] = [{ timestamp: now, value: 50 }];

    render(<SparklineCanvas data={data} color="--chart-cpu" />);

    flushOneFrame();

    expect(mockCtx.createLinearGradient).toHaveBeenCalled();
    expect(mockGradient.addColorStop).toHaveBeenCalledWith(0, CPU_AREA_START);
    expect(mockGradient.addColorStop).toHaveBeenCalledWith(1, CPU_AREA_END);
  });

  it('renders canvas with display: block style', () => {
    const { container } = render(<SparklineCanvas data={[]} color="--chart-cpu" />);
    const canvas = container.querySelector('canvas')!;
    expect(canvas.style.display).toBe('block');
  });

  it('wrapper div includes flex-shrink-0 class', () => {
    const { container } = render(<SparklineCanvas data={[]} color="--chart-cpu" />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain('flex-shrink-0');
  });

  it('rebuilds gradient when color prop changes after mount', () => {
    // Register a second color CSS variable set
    setCssColorVars('--chart-memory', MEMORY_LINE, MEMORY_AREA_START, MEMORY_AREA_END);

    let result: RenderResult;

    // Mount with initial color: canvas setup effect stores gradientCtxRef.current
    act(() => {
      result = render(<SparklineCanvas data={[]} color="--chart-cpu" />);
    });

    // Flush the queued RAF so the canvas setup effect has run and set gradientCtxRef.current
    flushOneFrame();

    const callsAfterMount = (mockCtx.createLinearGradient as Mock<typeof mockCtx.createLinearGradient>).mock.calls.length;
    expect(callsAfterMount).toBeGreaterThan(0);

    // Re-render with a different color: the color/height effect runs again and
    // now gradientCtxRef.current is set, so lines 62-65 execute
    act(() => {
      result!.rerender(<SparklineCanvas data={[]} color="--chart-memory" />);
    });

    const callsAfterRerender = (mockCtx.createLinearGradient as Mock<typeof mockCtx.createLinearGradient>).mock.calls.length;
    expect(callsAfterRerender).toBeGreaterThan(callsAfterMount);

    clearCssColorVars('--chart-memory');
  });
});
