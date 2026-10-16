import { memo, useEffect, useRef } from 'react';
import { resolveChartColors } from '@/lib/charts/css-vars';
import { calculateCleanYAxis } from '@/lib/charts/y-axis';
import { useVisibleRAF } from '@/hooks/useVisibleRAF';

interface TimeSeriesPoint {
  timestamp: number;
  value: number;
}

interface SparklineCanvasProps {
  data: TimeSeriesPoint[];
  color: string;
  height?: number;
  width?: number;
  className?: string;
}

const PADDING = 2;
// Drawable window: right edge is always Date.now(), points older than this
// render off-screen to the left. The sparkline accumulator store derives its
// seed gate from it.
export const SPARKLINE_TIME_WINDOW_MS = 30000;
const MAX_DECAY = 0.97;
const MAX_POINTS = 128; // Pre-allocated buffer ceiling (well above the ~35 points we expect)

export default memo(function SparklineCanvas({
  data,
  color,
  height = 24,
  width = 60,
  className,
}: SparklineCanvasProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const smoothMaxRef = useRef(0);
  const dataRef = useRef(data);
  const lineColorRef = useRef('');
  const areaStartColorRef = useRef('');
  const areaEndColorRef = useRef('');
  const rightEdgeTimeRef = useRef(0);
  const lastDrawTimeRef = useRef(0);

  // Pre-allocated buffers, written into every draw, never replaced
  const pointsXRef = useRef(new Float64Array(MAX_POINTS));
  const pointsYRef = useRef(new Float64Array(MAX_POINTS));

  // Cached gradient - only recreated when colors or dimensions change
  const gradientRef = useRef<CanvasGradient | null>(null);
  const gradientCtxRef = useRef<CanvasRenderingContext2D | null>(null);

  const drawWidth = width - PADDING * 2;
  const drawHeight = height - PADDING * 2;

  const drawNow = () => {
    const ctx = gradientCtxRef.current;
    const dot = dotRef.current;
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    const currentData = dataRef.current;
    const max = smoothMaxRef.current;
    const len = currentData.length;
    const pxBuf = pointsXRef.current;
    const pyBuf = pointsYRef.current;

    if (len === 0 || rightEdgeTimeRef.current === 0) {
      if (dot) dot.style.left = '-9999px';
      return;
    }

    // Time window calculation, inlined to avoid closure allocation
    const timeNow = Date.now();
    const leftEdgeTime = timeNow - SPARKLINE_TIME_WINDOW_MS;
    const timeScale = drawWidth / SPARKLINE_TIME_WINDOW_MS;

    // Write x/y coordinates into pre-allocated buffers (zero allocation)
    const count = Math.min(len, MAX_POINTS);
    for (let i = 0; i < count; i++) {
      const d = currentData[i];
      pxBuf[i] = PADDING + (d.timestamp - leftEdgeTime) * timeScale;
      pyBuf[i] = PADDING + drawHeight - (d.value / max) * drawHeight;
    }

    const bottom = height - PADDING;

    // Draw gradient area
    ctx.beginPath();
    ctx.moveTo(pxBuf[0], pyBuf[0]);
    for (let i = 1; i < count; i++) {
      ctx.lineTo(pxBuf[i], pyBuf[i]);
    }
    ctx.lineTo(pxBuf[count - 1], bottom);
    ctx.lineTo(pxBuf[0], bottom);
    ctx.closePath();
    if (gradientRef.current) {
      ctx.fillStyle = gradientRef.current;
      ctx.fill();
    }

    // Draw line
    ctx.beginPath();
    ctx.moveTo(pxBuf[0], pyBuf[0]);
    for (let i = 1; i < count; i++) {
      ctx.lineTo(pxBuf[i], pyBuf[i]);
    }

    ctx.strokeStyle = lineColorRef.current;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    if (dot) {
      dot.style.left = `${pxBuf[count - 1]}px`;
      dot.style.top = `${pyBuf[count - 1]}px`;
    }
  };
  const drawRef = useRef(drawNow);
  drawRef.current = drawNow;

  // Resolve colors and rebuild gradient when color or height changes
  useEffect(() => {
    const colors = resolveChartColors(color);
    lineColorRef.current = colors.line;
    areaStartColorRef.current = colors.areaStart;
    areaEndColorRef.current = colors.areaEnd;
    if (dotRef.current) dotRef.current.style.backgroundColor = colors.line;

    // Rebuild cached gradient, skip if CSS vars unresolved
    const ctx = gradientCtxRef.current;
    if (ctx && areaStartColorRef.current && areaEndColorRef.current) {
      const gradient = ctx.createLinearGradient(0, PADDING, 0, height - PADDING);
      gradient.addColorStop(0, areaStartColorRef.current);
      gradient.addColorStop(1, areaEndColorRef.current);
      gradientRef.current = gradient;
    }
  }, [color, height]);

  // Canvas setup (DPR scaling, gradient initialization). Runs once per width/height change.
  // Declared before the data effect so a mount that already has data draws on
  // the first commit instead of waiting for a ticker tick.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    // Store ctx ref so the color-change and data-change effects can use it
    gradientCtxRef.current = ctx;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // Build initial gradient, guarding against empty color refs (CSS vars may not yet be resolved)
    if (areaStartColorRef.current && areaEndColorRef.current) {
      const gradient = ctx.createLinearGradient(0, PADDING, 0, height - PADDING);
      gradient.addColorStop(0, areaStartColorRef.current);
      gradient.addColorStop(1, areaEndColorRef.current);
      gradientRef.current = gradient;
    }

    lastDrawTimeRef.current = 0;

    return () => {
      gradientCtxRef.current = null;
      gradientRef.current = null;
    };
  }, [width, height]);

  // Update data refs and redraw when data changes. The line/area only change
  // here; the pulse dot is a CSS-animated DOM element, so no per-frame canvas
  // redraw is needed while the pulse fades.
  useEffect(() => {
    dataRef.current = data;

    if (data.length > 0) {
      rightEdgeTimeRef.current = data[data.length - 1].timestamp;

      // Stable max with decay - use same y-axis scaling as ECharts for consistent visual representation
      let rawMax = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i].value > rawMax) rawMax = data[i].value;
      }
      const { max: niceMax } = calculateCleanYAxis(rawMax, 'linear');
      smoothMaxRef.current =
        smoothMaxRef.current === 0
          ? niceMax
          : Math.max(niceMax, smoothMaxRef.current * MAX_DECAY);
    }

    drawRef.current();
  }, [data]);

  // Throttle interval when idle: ~4fps keeps the time-axis sliding smoothly
  // without burning GPU on full-rate draws per sparkline.
  const IDLE_INTERVAL_MS = 250;

  // Ticker-driven redraws only slide the time window between data arrivals;
  // the first tick after (re)subscribe always draws (lastDrawTimeRef is 0).
  useVisibleRAF(wrapperRef, (now: number) => {
    if (lastDrawTimeRef.current !== 0 && now - lastDrawTimeRef.current < IDLE_INTERVAL_MS) return;
    lastDrawTimeRef.current = now;
    drawRef.current();
  });

  return (
    <div ref={wrapperRef} className={`relative shrink-0 ${className ?? ''}`} style={{ contain: 'strict', height, width }}>
      <canvas ref={canvasRef} style={{ width, height, display: 'block' }} />
      {data.length > 0 && (
        <div
          ref={dotRef}
          // New key per latest point remounts the node, restarting the pulse animation.
          key={data[data.length - 1].timestamp}
          className="sparkline-dot"
          style={{ backgroundColor: lineColorRef.current }}
        />
      )}
    </div>
  );
});
