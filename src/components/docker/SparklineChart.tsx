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
  const lastDataHashRef = useRef('');
  const lineProgressRef = useRef(1);
  const pulseProgressRef = useRef(1); // 0 = just started, 1 = done
  const lineColorRef = useRef('');
  const areaStartColorRef = useRef('');
  const areaEndColorRef = useRef('');
  const rightEdgeTimeRef = useRef(0); // Fixed right edge timestamp

  const drawWidth = width - PADDING * 2;
  const drawHeight = height - PADDING * 2;

  // Update refs when data or color changes
  useEffect(() => {
    const dataHash = data.map(d => `${d.timestamp}:${d.value.toFixed(2)}`).join(',');
    const hasNewData = dataHash !== lastDataHashRef.current && lastDataHashRef.current !== '';
    lastDataHashRef.current = dataHash;

    dataRef.current = data;

    lineColorRef.current = getCssVar(color);
    areaStartColorRef.current = getCssVar(`${color}-area-start`);
    areaEndColorRef.current = getCssVar(`${color}-area-end`);

    // When new data arrives, update right edge to latest timestamp
    if (data.length > 0) {
      const latestTimestamp = data[data.length - 1].timestamp;
      rightEdgeTimeRef.current = latestTimestamp;

      if (hasNewData) {
        lineProgressRef.current = 0; // Animate line to new point
        pulseProgressRef.current = 0; // Start pulse animation
      }
    }

    // Stable max with decay
    if (data.length > 0) {
      const rawMax = Math.max(Math.max(...data.map(d => d.value)) * 1.1, 1);
      smoothMaxRef.current =
        smoothMaxRef.current === 0
          ? rawMax
          : Math.max(rawMax, smoothMaxRef.current * MAX_DECAY);
    }
  }, [data, color]);

  // Canvas setup and animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    let lastFrameTime = performance.now();

    const render = (now: number) => {
      animFrameRef.current = requestAnimationFrame(render);

      const delta = now - lastFrameTime;
      lastFrameTime = now;

      // Animate line progress
      const lineProgressPerMs = 1 / 150;
      lineProgressRef.current = Math.min(1, lineProgressRef.current + lineProgressPerMs * delta);

      // Animate pulse (1200ms duration for smooth, less distracting appearance)
      const pulseProgressPerMs = 1 / 1200;
      pulseProgressRef.current = Math.min(1, pulseProgressRef.current + pulseProgressPerMs * delta);

      const lineProgress = lineProgressRef.current;
      const pulseProgress = pulseProgressRef.current;
      const currentData = dataRef.current;
      const max = smoothMaxRef.current;
      const currentRightEdge = rightEdgeTimeRef.current;

      ctx.clearRect(0, 0, width, height);

      if (currentData.length === 0 || currentRightEdge === 0) return;

      // Natural scrolling: as real time progresses, right edge stays at a fixed timestamp,
      // so the time window effectively scrolls left relative to "now"
      const timeNow = Date.now();
      const timeSinceLatest = timeNow - currentRightEdge;

      // Right edge position: latest data timestamp, adjusted for time passed
      const visualRightEdge = currentRightEdge + timeSinceLatest;
      const leftEdgeTime = visualRightEdge - TIME_WINDOW_MS;

      // Convert timestamp to X coordinate
      const timeToX = (timestamp: number) => {
        const timeOffset = timestamp - leftEdgeTime;
        const fraction = timeOffset / TIME_WINDOW_MS;
        return PADDING + fraction * drawWidth;
      };

      // Build points
      const points = currentData.map((d) => {
        const x = timeToX(d.timestamp);
        const y = PADDING + drawHeight - (d.value / max) * drawHeight;
        return [x, y] as const;
      });

      const bottom = height - PADDING;

      if (points.length === 0) return;

      // Draw gradient area
      const gradient = ctx.createLinearGradient(0, PADDING, 0, height - PADDING);
      gradient.addColorStop(0, areaStartColorRef.current);
      gradient.addColorStop(1, areaEndColorRef.current);

      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i][0], points[i][1]);
      }
      ctx.lineTo(points[points.length - 1][0], bottom);
      ctx.lineTo(points[0][0], bottom);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();

      // Draw line with partial last segment
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);

      for (let i = 1; i < points.length; i++) {
        if (i === points.length - 1 && lineProgress < 1) {
          const prevPt = points[i - 1];
          const currPt = points[i];
          const lerpX = prevPt[0] + (currPt[0] - prevPt[0]) * lineProgress;
          const lerpY = prevPt[1] + (currPt[1] - prevPt[1]) * lineProgress;
          ctx.lineTo(lerpX, lerpY);
        } else {
          ctx.lineTo(points[i][0], points[i][1]);
        }
      }

      ctx.strokeStyle = lineColorRef.current;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Draw persistent dot at the latest point with fade out/in animation on new data
      if (points.length > 0) {
        const lastPoint = points[points.length - 1];
        const baseOpacity = 0.3; // Baseline visibility at 30% opacity
        const radius = 2; // Constant size

        let opacity: number;

        if (pulseProgress < 1) {
          // Animating - fade out and back in
          // Split animation into: fade out (0-0.3), fade in (0.3-0.7), settle to baseline (0.7-1.0)
          if (pulseProgress < 0.3) {
            // Fade out phase: baseline → 0
            const fadeOutProgress = pulseProgress / 0.3;
            opacity = baseOpacity * (1 - fadeOutProgress);
          } else if (pulseProgress < 0.7) {
            // Fade in phase: 0 → peak (0.6)
            const fadeInProgress = (pulseProgress - 0.3) / 0.4;
            const peakOpacity = 0.6;
            opacity = fadeInProgress * peakOpacity;
          } else {
            // Settle phase: peak → baseline
            const settleProgress = (pulseProgress - 0.7) / 0.3;
            const peakOpacity = 0.6;
            opacity = peakOpacity - settleProgress * (peakOpacity - baseOpacity);
          }
        } else {
          // Not animating - show at baseline
          opacity = baseOpacity;
        }

        // Draw the persistent dot
        ctx.beginPath();
        ctx.arc(lastPoint[0], lastPoint[1], radius, 0, Math.PI * 2);
        ctx.fillStyle = lineColorRef.current.replace(/rgb\((.+)\)/, `rgba($1, ${Math.max(0, opacity)})`);
        ctx.fill();
      }
    };

    animFrameRef.current = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [width, height, drawWidth, drawHeight]);

  return (
    <div className={className} style={{ contain: 'strict', height, width }}>
      <canvas ref={canvasRef} style={{ width, height, display: 'block' }} />
    </div>
  );
});
