import { memo, useRef, useEffect } from 'react';
import {
  createChart,
  AreaSeries,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';

export interface SparklineDataPoint {
  time: number; // Unix timestamp in ms
  value: number;
}

interface SparklineChartProps {
  data: SparklineDataPoint[];
  color: string;
  height?: number;
  width?: number;
  className?: string;
}

function getCssVar(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export default memo(function SparklineChart({
  data,
  color,
  height = 24,
  width = 60,
  className,
}: SparklineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);

  // Create chart once on mount
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      width,
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: 'transparent',
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      crosshair: {
        mode: CrosshairMode.Hidden,
        vertLine: { visible: false },
        horzLine: { visible: false },
      },
      timeScale: {
        visible: false,
        borderVisible: false,
      },
      rightPriceScale: {
        visible: false,
        borderVisible: false,
      },
      leftPriceScale: {
        visible: false,
        borderVisible: false,
      },
      handleScroll: false,
      handleScale: false,
      kineticScroll: { mouse: false, touch: false },
      autoSize: false,
    });

    const lineColor = getCssVar(color);
    const topColor = getCssVar(`${color}-area-start`);
    const bottomColor = getCssVar(`${color}-area-end`);

    const series = chart.addSeries(AreaSeries, {
      lineColor,
      topColor,
      bottomColor,
      lineWidth: 1,
      crosshairMarkerVisible: false,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      chartRef.current = null;
      seriesRef.current = null;
      chart.remove();
    };
  }, [width, height, color]);

  // Update data using real-time update API
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart || data.length === 0) return;

    const chartData = data.map((d) => ({
      time: Math.floor(d.time / 1000) as UTCTimestamp,
      value: d.value,
    }));

    series.setData(chartData);
    chart.timeScale().fitContent();
  }, [data]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ contain: 'strict', height, width }}
    />
  );
});
