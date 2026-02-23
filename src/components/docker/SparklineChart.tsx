import { memo, useEffect, useRef } from 'react';

interface TimeSeriesPoint {
  timestamp: number;
  value: number;
}

interface SparklineChartProps {
  data: TimeSeriesPoint[];
  color: string;
  height?: number;
  width?: number;
  className?: string;
}

function getCssVar(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const PADDING = 2;
const TIME_WINDOW_MS = 30000; // 30 seconds
const MAX_DECAY = 0.97;
const MAX_POINTS = 128; // Pre-allocated buffer ceiling (well above the ~35 points we expect)

export default memo(function SparklineChart({
  data,
  color,
  height = 24,
  width = 60,
  className,
}: SparklineChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef(0);
  const smoothMaxRef = useRef(0);
  const dataRef = useRef(data);
  const lastEndTimestampRef = useRef(0);
  const pulseProgressRef = useRef(1);
  const lineColorRef = useRef('');
  const areaStartColorRef = useRef('');
  const areaEndColorRef = useRef('');
  const rightEdgeTimeRef = useRef(0);

  // Pre-allocated buffers — written into every frame, never replaced
  const pointsXRef = useRef(new Float64Array(MAX_POINTS));
  const pointsYRef = useRef(new Float64Array(MAX_POINTS));

  // Cached gradient — only recreated when colors or dimensions change
  const gradientRef = useRef<CanvasGradient | null>(null);
  const gradientCtxRef = useRef<CanvasRenderingContext2D | null>(null);

  // Cached rgba base string for dot color (avoids per-frame regex)
  const dotColorBaseRef = useRef('');

  const drawWidth = width - PADDING * 2;
  const drawHeight = height - PADDING * 2;

  // Update refs when data or color changes
  useEffect(() => {
    dataRef.current = data;

    const lineColor = getCssVar(color);
    lineColorRef.current = lineColor;
    areaStartColorRef.current = getCssVar(`${color}-area-start`);
    areaEndColorRef.current = getCssVar(`${color}-area-end`);

    // Extract rgb components once for dot opacity rendering (avoids per-frame regex)
    const rgbMatch = lineColor.match(/rgb\((.+)\)/);
    dotColorBaseRef.current = rgbMatch ? rgbMatch[1] : '0,0,0';

    // Rebuild cached gradient when colors change
    const ctx = gradientCtxRef.current;
    if (ctx) {
      const gradient = ctx.createLinearGradient(0, PADDING, 0, height - PADDING);
      gradient.addColorStop(0, areaStartColorRef.current);
      gradient.addColorStop(1, areaEndColorRef.current);
      gradientRef.current = gradient;
    }

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

    // Stable max with decay
    if (data.length > 0) {
      let rawMax = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i].value > rawMax) rawMax = data[i].value;
      }
      rawMax = Math.max(rawMax * 1.1, 1);
      smoothMaxRef.current =
        smoothMaxRef.current === 0
          ? rawMax
          : Math.max(rawMax, smoothMaxRef.current * MAX_DECAY);
    }
  }, [data, color, height]);

  // Canvas setup and animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    // Store ctx ref so the data-change effect can rebuild the gradient
    gradientCtxRef.current = ctx;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // Build initial gradient
    const gradient = ctx.createLinearGradient(0, PADDING, 0, height - PADDING);
    gradient.addColorStop(0, areaStartColorRef.current);
    gradient.addColorStop(1, areaEndColorRef.current);
    gradientRef.current = gradient;

    let lastFrameTime = performance.now();

    // Pre-read buffer refs once (the Float64Arrays themselves never change)
    const pxBuf = pointsXRef.current;
    const pyBuf = pointsYRef.current;

    const render = (now: number) => {
      animFrameRef.current = requestAnimationFrame(render);

      const delta = now - lastFrameTime;
      lastFrameTime = now;

      // Animate pulse
      pulseProgressRef.current = Math.min(1, pulseProgressRef.current + delta / 1200);

      const pulseProgress = pulseProgressRef.current;
      const currentData = dataRef.current;
      const max = smoothMaxRef.current;
      const currentRightEdge = rightEdgeTimeRef.current;

      ctx.clearRect(0, 0, width, height);

      const len = currentData.length;
      if (len === 0 || currentRightEdge === 0) return;

      // Time window calculation (inlined — no closure allocation)
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
      ctx.fillStyle = gradientRef.current!;
      ctx.fill();

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
      const peakOpacity = 0.7;
      const opacity = pulseProgress < 1
        ? peakOpacity - (peakOpacity - baseOpacity) * pulseProgress
        : baseOpacity;

      ctx.beginPath();
      ctx.arc(lastX, lastY, radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${dotColorBaseRef.current}, ${Math.max(0, opacity)})`;
      ctx.fill();
    };

    animFrameRef.current = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      gradientCtxRef.current = null;
      gradientRef.current = null;
    };
  }, [width, height, drawWidth, drawHeight]);

  return (
    <div className={`flex-shrink-0 ${className ?? ''}`} style={{ contain: 'strict', height, width }}>
      <canvas ref={canvasRef} style={{ width, height, display: 'block' }} />
    </div>
  );
});
