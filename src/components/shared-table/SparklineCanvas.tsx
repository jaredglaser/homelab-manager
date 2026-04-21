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
const TIME_WINDOW_MS = 30000; // 30 seconds
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
  const smoothMaxRef = useRef(0);
  const dataRef = useRef(data);
  const lastEndTimestampRef = useRef(0);
  const pulseProgressRef = useRef(1);
  const lineColorRef = useRef('');
  const areaStartColorRef = useRef('');
  const areaEndColorRef = useRef('');
  const rightEdgeTimeRef = useRef(0);
  const lastFrameTimeRef = useRef(0);
  const lastDrawTimeRef = useRef(0);

  // Pre-allocated buffers - written into every frame, never replaced
  const pointsXRef = useRef(new Float64Array(MAX_POINTS));
  const pointsYRef = useRef(new Float64Array(MAX_POINTS));

  // Cached gradient - only recreated when colors or dimensions change
  const gradientRef = useRef<CanvasGradient | null>(null);
  const gradientCtxRef = useRef<CanvasRenderingContext2D | null>(null);

  const drawWidth = width - PADDING * 2;
  const drawHeight = height - PADDING * 2;

  // Resolve colors and rebuild gradient when color or height changes
  useEffect(() => {
    const colors = resolveChartColors(color);
    lineColorRef.current = colors.line;
    areaStartColorRef.current = colors.areaStart;
    areaEndColorRef.current = colors.areaEnd;

    // Rebuild cached gradient, skip if CSS vars unresolved
    const ctx = gradientCtxRef.current;
    if (ctx && areaStartColorRef.current && areaEndColorRef.current) {
      const gradient = ctx.createLinearGradient(0, PADDING, 0, height - PADDING);
      gradient.addColorStop(0, areaStartColorRef.current);
      gradient.addColorStop(1, areaEndColorRef.current);
      gradientRef.current = gradient;
    }
  }, [color, height]);

  // Update data refs when data changes
  useEffect(() => {
    dataRef.current = data;

    if (data.length > 0) {
      const latestTimestamp = data[data.length - 1].timestamp;
      rightEdgeTimeRef.current = latestTimestamp;

      // Only reset animation when a new point appears at the end,
      // not when old points are trimmed from the beginning
      if (latestTimestamp !== lastEndTimestampRef.current && lastEndTimestampRef.current !== 0) {
        pulseProgressRef.current = 0;
      }
      lastEndTimestampRef.current = latestTimestamp;
    }

    // Stable max with decay - use same y-axis scaling as ECharts for consistent visual representation
    if (data.length > 0) {
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
  }, [data]);

  // Canvas setup (DPR scaling, gradient initialization). Runs once per width/height change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    // Store ctx ref so the data-change effect (and render loop) can use it
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

    lastFrameTimeRef.current = performance.now();
    lastDrawTimeRef.current = 0;

    return () => {
      gradientCtxRef.current = null;
      gradientRef.current = null;
    };
  }, [width, height]);

  // Throttle interval when idle (pulse done): ~4fps keeps the time-axis
  // sliding smoothly without burning GPU on 60fps draws per sparkline.
  const IDLE_INTERVAL_MS = 250;

  // After useVisibleRAF re-enters visibility, lastFrameTimeRef can be seconds
  // stale. Treat any delta over this as a resume, not a real frame gap, so an
  // in-flight pulse doesn't saturate (0 → 1) in a single post-resume tick.
  const PULSE_RESUME_THRESHOLD_MS = 100;

  // Per-frame render, gated by useVisibleRAF: only runs while wrapper is in viewport.
  useVisibleRAF(wrapperRef, (now: number) => {
    const ctx = gradientCtxRef.current;
    if (!ctx) return;

    const pxBuf = pointsXRef.current;
    const pyBuf = pointsYRef.current;

    const rawDelta = now - lastFrameTimeRef.current;
    lastFrameTimeRef.current = now;
    const delta = rawDelta > PULSE_RESUME_THRESHOLD_MS ? 0 : rawDelta;

    // Animate pulse
    pulseProgressRef.current = Math.min(1, pulseProgressRef.current + delta / 1200);

    const pulseProgress = pulseProgressRef.current;

    // Throttle: full framerate during pulse, ~4fps when idle
    if (pulseProgress >= 1 && now - lastDrawTimeRef.current < IDLE_INTERVAL_MS) return;
    lastDrawTimeRef.current = now;

    const currentData = dataRef.current;
    const max = smoothMaxRef.current;
    const currentRightEdge = rightEdgeTimeRef.current;

    ctx.clearRect(0, 0, width, height);

    const len = currentData.length;
    if (len === 0 || currentRightEdge === 0) return;

    // Time window calculation (inlined - no closure allocation)
    const timeNow = Date.now();
    const visualRightEdge = timeNow; // currentRightEdge + (timeNow - currentRightEdge)
    const leftEdgeTime = visualRightEdge - TIME_WINDOW_MS;
    const timeScale = drawWidth / TIME_WINDOW_MS;

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

    // Draw persistent dot with fade animation (no per-frame string allocation)
    const lastX = pxBuf[count - 1];
    const lastY = pyBuf[count - 1];
    const baseOpacity = 0.3;
    const radius = 2;

    // Pulse brightens from peak to baseline (never fades out, so the dot stays visible)
    const peakOpacity = 0.8;
    const opacity = pulseProgress < 1
      ? peakOpacity - (peakOpacity - baseOpacity) * pulseProgress
      : baseOpacity;

    ctx.save();
    ctx.globalAlpha = Math.max(0, opacity);
    ctx.beginPath();
    ctx.arc(lastX, lastY, radius, 0, Math.PI * 2);
    ctx.fillStyle = lineColorRef.current;
    ctx.fill();
    ctx.restore();
  });

  return (
    <div ref={wrapperRef} className={`flex-shrink-0 ${className ?? ''}`} style={{ contain: 'strict', height, width }}>
      <canvas ref={canvasRef} style={{ width, height, display: 'block' }} />
    </div>
  );
});
