import { memo, useMemo } from 'react';
import { Paper, Typography } from '@mui/material';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { useGeneralSettings } from '@/hooks/useSettings';
import { resolveChartColors, resolveChartChromeColors } from '@/lib/charts/css-vars';
import { calculateCleanYAxis } from '@/lib/charts/y-axis';

interface DataPoint {
  timestamp: number;
  value: number;
}

interface HistoricalMetricChartProps {
  title: string;
  dataPoints: DataPoint[];
  colorVar: string;
  formatValue: (value: number) => string;
  from: number;
  to: number;
}

/**
 * Produce a formatted time label for an x-axis tick based on the total range.
 *
 * For ranges longer than 24 hours, returns a two-line label with a short month/day on the first line and a hours:minutes time on the second line; otherwise returns a time string including hours, minutes, and seconds. 
 *
 * @param value - Timestamp in milliseconds since the Unix epoch
 * @param rangeMs - Total displayed time range in milliseconds used to decide label format
 * @param use12Hour - Whether to format times using 12-hour clock (AM/PM) when applicable
 * @returns The formatted time label string; for ranges > 24 hours this contains a newline separating date and time
 */
function formatTimeLabel(value: number, rangeMs: number, use12Hour: boolean): string {
  const d = new Date(value);
  if (rangeMs > 86_400_000) {
    const month = d.toLocaleString([], { month: 'short' });
    const day = d.getDate();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: use12Hour });
    return `${month} ${day}\n${time}`;
  }
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: use12Hour });
}

/**
 * Build an ECharts option object for rendering a time-series line chart with a smooth line and gradient area.
 *
 * @param dataPoints - Array of data points where each item contains a `timestamp` (milliseconds since epoch) and a numeric `value`
 * @param colorVar - CSS color variable name used to resolve series colors
 * @param formatValue - Function to format numeric y-axis and tooltip values into display strings
 * @param isPercent - Whether the values represent percentages (affects y-axis scaling)
 * @param use12HourTime - Whether to format time labels using 12-hour clock
 * @param from - Minimum x-axis timestamp (milliseconds since epoch)
 * @param to - Maximum x-axis timestamp (milliseconds since epoch)
 * @returns An EChartsOption configured with time x-axis, computed y-axis max/interval, formatted tooltip, styled axes, and a single smooth line series with gradient area fill
 */
function getChartOption(
  dataPoints: DataPoint[],
  colorVar: string,
  formatValue: (value: number) => string,
  isPercent: boolean,
  use12HourTime: boolean,
  from: number,
  to: number,
): EChartsOption {
  const rangeMs = to - from;
  const timeValuePairs = dataPoints.map((d) => [d.timestamp, d.value] as [number, number]);
  const values = dataPoints.map((d) => d.value);

  const maxValue = values.reduce((max, v) => (v > max ? v : max), 0);
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
      bottom: 30,
      left: 55,
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
        const paramArray = params as { value: [number, number] }[];
        const ts = paramArray[0]?.value?.[0];
        const val = paramArray[0]?.value?.[1] ?? 0;
        const time = ts ? new Date(ts).toLocaleTimeString([], timeFormatOpts) : '';
        return `${time}<br/>${formatValue(val)}`;
      },
    },
    xAxis: {
      type: 'time',
      min: from,
      max: to,
      splitNumber: 5,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        show: true,
        color: chrome.textMuted,
        fontSize: 9,
        hideOverlap: true,
        formatter: (value: number) => formatTimeLabel(value, rangeMs, use12HourTime),
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

export default memo(function HistoricalMetricChart({
  title,
  dataPoints,
  colorVar,
  formatValue,
  from,
  to,
}: HistoricalMetricChartProps) {
  const { general } = useGeneralSettings();
  const isPercent = title.includes('%');
  const option = useMemo(
    () => getChartOption(dataPoints, colorVar, formatValue, isPercent, general.use12HourTime, from, to),
    [dataPoints, colorVar, formatValue, isPercent, general.use12HourTime, from, to],
  );

  return (
    <Paper elevation={0} className="rounded-sm p-3 bg-(--mui-palette-background-chartBg)">
      <Typography variant="body2" className="mb-1 font-medium">
        {title}
      </Typography>
      <div className="h-64">
        <ReactECharts
          option={option}
          style={{ height: '100%', width: '100%' }}
          opts={{ renderer: 'canvas' }}
          notMerge={false}
          lazyUpdate={true}
        />
      </div>
    </Paper>
  );
});
