import { memo, useMemo } from 'react';
import { Sheet, Typography } from '@mui/joy';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { useSettings } from '@/hooks/useSettings';
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
  const { general } = useSettings();
  const isPercent = title.includes('%');
  const option = useMemo(
    () => getChartOption(dataPoints, colorVar, formatValue, isPercent, general.use12HourTime, from, to),
    [dataPoints, colorVar, formatValue, isPercent, general.use12HourTime, from, to],
  );

  return (
    <Sheet variant="soft" className="rounded-sm p-3">
      <Typography level="body-sm" className="mb-1 font-medium">
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
    </Sheet>
  );
});
