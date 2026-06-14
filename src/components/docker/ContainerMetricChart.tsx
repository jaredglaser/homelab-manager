import { memo, useMemo, useRef } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { useDockerSettings, useGeneralSettings } from '@/hooks/useSettings';
import { useEChartTimeScroll } from '@/hooks/useEChartTimeScroll';
import { resolveChartColors, resolveChartChromeColors } from '@/lib/charts/css-vars';
import { calculateCleanYAxis } from '@/lib/charts/y-axis';

interface DataPoint {
  timestamp: number;
  value: number;
}

interface ContainerMetricChartProps {
  title: string;
  dataPoints: DataPoint[];
  colorVar: string;
  formatValue: (value: number) => string;
}

/**
 * Builds an ECharts option for a smoothed time-series line chart of the provided data points.
 *
 * @param dataPoints - Array of data points where each item contains a numeric `timestamp` (milliseconds since epoch) and a numeric `value`
 * @param colorVar - CSS color variable name used to derive the series and area colors
 * @param formatValue - Function that formats numeric y values for axis labels and the tooltip
 * @param isPercent - When true, y-axis scaling is calculated using a percent-oriented strategy
 * @param use12HourTime - When true, tooltip times are formatted using a 12-hour clock; otherwise a 24-hour clock is used
 * @param windowMs - Duration in milliseconds of the x-axis time window
 * @returns An EChartsOption configured for a smoothed, symbol-less line series with gradient area fill, a time x-axis spanning now - windowMs to now, and a y-axis starting at 0 with a cleaned maximum and interval; tooltip shows localized time and the formatted value
 */
function getChartOption(
  dataPoints: DataPoint[],
  colorVar: string,
  formatValue: (value: number) => string,
  isPercent: boolean,
  use12HourTime: boolean,
  windowMs: number
): EChartsOption {
  const now = Date.now();
  const timeValuePairs = dataPoints.map((d) => [d.timestamp, d.value] as [number, number]);
  const values = dataPoints.map((d) => d.value);

  const maxValue = Math.max(...values, 0);
  const { max: yAxisMax, interval: yAxisInterval } = calculateCleanYAxis(
    maxValue,
    isPercent ? 'percent' : 'linear',
  );

  const seriesColors = resolveChartColors(colorVar);
  const chrome = resolveChartChromeColors();

  const timeFormatOpts: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: use12HourTime,
  };

  return {
    animation: false,
    grid: {
      top: 10,
      right: 15,
      bottom: 25,
      left: 50,
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: chrome.tooltipBg,
      borderColor: chrome.border,
      textStyle: {
        color: chrome.tooltipText,
        fontSize: 12,
      },
      formatter: (params: unknown) => {
        const paramArray = params as {
          value: [number, number];
        }[];
        const ts = paramArray[0]?.value?.[0];
        const val = paramArray[0]?.value?.[1] ?? 0;
        const time = ts ? new Date(ts).toLocaleTimeString([], timeFormatOpts) : '';
        return `${time}<br/>${formatValue(val)}`;
      },
    },
    xAxis: {
      type: 'time',
      min: now - windowMs,
      max: now,
      splitNumber: 4,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        show: true,
        color: chrome.textMuted,
        fontSize: 9,
        formatter: (value: number) => {
          const d = new Date(value);
          return `${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
        },
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: yAxisMax,
      interval: yAxisInterval,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: chrome.textMuted,
        fontSize: 9,
        formatter: (value: number) => formatValue(value),
      },
      splitLine: {
        lineStyle: {
          color: chrome.border,
          type: 'dashed',
        },
      },
    },
    series: [
      {
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: timeValuePairs,
        lineStyle: { color: seriesColors.line, width: 2 },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: seriesColors.areaStart },
              { offset: 1, color: seriesColors.areaEnd },
            ],
          },
        },
      },
    ],
  };
}

export default memo(function ContainerMetricChart({
  title,
  dataPoints,
  colorVar,
  formatValue,
}: ContainerMetricChartProps) {
  const { general } = useGeneralSettings();
  const { docker } = useDockerSettings();
  const windowMs = docker.chartWindowSeconds * 1000;
  const isPercent = title.includes('%');
  const option = useMemo(
    () => getChartOption(dataPoints, colorVar, formatValue, isPercent, general.use12HourTime, windowMs),
    [dataPoints, colorVar, formatValue, isPercent, general.use12HourTime, windowMs],
  );
  const chartRef = useRef<ReactECharts>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEChartTimeScroll(chartRef, windowMs, wrapperRef);

  return (
    <div className="rounded-sm p-3 bg-chart-bg">
      <p className="text-sm mb-1 font-medium">
        {title}
      </p>
      <div ref={wrapperRef} className="h-32">
        <ReactECharts
          ref={chartRef}
          option={option}
          style={{ height: '100%', width: '100%' }}
          opts={{ renderer: 'canvas' }}
          notMerge={false}
          lazyUpdate={true}
        />
      </div>
    </div>
  );
});
