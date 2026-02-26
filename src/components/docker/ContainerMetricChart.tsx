import { memo, useMemo, useRef } from 'react';
import { Sheet, Typography } from '@mui/joy';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { useSettings } from '@/hooks/useSettings';
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

const WINDOW_MS = 300_000;

function getChartOption(
  dataPoints: DataPoint[],
  colorVar: string,
  formatValue: (value: number) => string,
  isPercent: boolean,
  use12HourTime: boolean
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
      min: now - WINDOW_MS,
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
  const { general } = useSettings();
  const isPercent = title.includes('%');
  const option = useMemo(
    () => getChartOption(dataPoints, colorVar, formatValue, isPercent, general.use12HourTime),
    [dataPoints, colorVar, formatValue, isPercent, general.use12HourTime],
  );
  const chartRef = useRef<ReactECharts>(null);

  useEChartTimeScroll(chartRef, WINDOW_MS);

  return (
    <Sheet variant="soft" className="rounded-sm p-3">
      <Typography level="body-sm" className="mb-1 font-medium">
        {title}
      </Typography>
      <div className="h-32">
        <ReactECharts
          ref={chartRef}
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
