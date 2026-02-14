import { memo, useId } from 'react';

interface SparklineChartProps {
  data: number[];
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

export default memo(function SparklineChart({
  data,
  color,
  height = 24,
  width = 60,
  className,
}: SparklineChartProps) {
  const rawId = useId();
  const gradientId = `spark${rawId.replace(/:/g, '')}`;

  const lineColor = getCssVar(color);
  const drawWidth = width - PADDING * 2;
  const drawHeight = height - PADDING * 2;
  const max = Math.max(Math.max(...data) * 1.1, 1);
  const bottom = height - PADDING;

  // Build SVG coordinate points
  const len = data.length;
  const points = data.map((v, i) => {
    const x = PADDING + (len === 1 ? drawWidth / 2 : (i / (len - 1)) * drawWidth);
    const y = PADDING + drawHeight - (v / max) * drawHeight;
    return [x, y] as const;
  });

  const lineD = points.map(([x, y], i) =>
    `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  ).join('');

  // Close the path along the bottom edge for the area fill
  const areaD = len > 0
    ? `${lineD}L${(PADDING + drawWidth).toFixed(1)},${bottom}L${PADDING},${bottom}Z`
    : '';

  const areaStart = getCssVar(`${color}-area-start`);
  const areaEnd = getCssVar(`${color}-area-end`);

  return (
    <div className={className} style={{ contain: 'strict', height, width }}>
      <svg width={width} height={height}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={areaStart} />
            <stop offset="1" stopColor={areaEnd} />
          </linearGradient>
        </defs>
        {areaD && <path d={areaD} fill={`url(#${gradientId})`} />}
        {lineD && <path d={lineD} fill="none" stroke={lineColor} strokeWidth={1.5} />}
      </svg>
    </div>
  );
});
