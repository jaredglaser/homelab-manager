import { memo, useMemo, useRef } from 'react';
import { Paper, Typography } from '@mui/material';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { useSettings } from '@/hooks/useSettings';
import { useEChartTimeScroll } from '@/hooks/useEChartTimeScroll';
import { resolveChartColors, resolveChartChromeColors } from '@/lib/charts/css-vars';
import { calculateCleanYAxis, type YAxisMode } from '@/lib/charts/y-axis';

interface DataPoint {
  timestamp: number;
  value: number;
}

interface SeriesConfig {
  name: string;
  dataPoints: DataPoint[];
  colorVar: string;
}

interface DualSeriesChartProps {
  title: string;
  series: [SeriesConfig, SeriesConfig];
  yAxisMode: YAxisMode;
  formatValue: (value: number) => string;
}

/** @internal Exported for testing */
export function getChartOption(
  series: [SeriesConfig, SeriesConfig],
  yAxisMode: YAxisMode,
  formatValue: (value: number) => string,
  use12HourTime: boolean,
  windowMs: number,
): EChartsOption {
  const now = Date.now();

  const pairs0 = series[0].dataPoints.map((d) => [d.timestamp, d.value] as [number, number]);
  const pairs1 = series[1].dataPoints.map((d) => [d.timestamp, d.value] as [number, number]);

  const maxValue = Math.max(
    ...series[0].dataPoints.map((d) => d.value),
    ...series[1].dataPoints.map((d) => d.value),
    0,
  );
  const { max: yAxisMax, interval: yAxisInterval } = calculateCleanYAxis(maxValue, yAxisMode);

  const colors0 = resolveChartColors(series[0].colorVar);
  const colors1 = resolveChartColors(series[1].colorVar);
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
      bottom: 45,
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
          marker: string;
          seriesName: string;
        }[];
        const ts = paramArray[0]?.value?.[0];
        const time = ts ? new Date(ts).toLocaleTimeString([], timeFormatOpts) : '';
        const lines = paramArray.map(
          (p) => `${p.marker} ${p.seriesName}: ${formatValue(p.value[1])}`,
        );
        return `${time}<br/>${lines.join('<br/>')}`;
      },
    },
    legend: {
      show: true,
      bottom: 0,
      textStyle: {
        color: chrome.textMuted,
        fontSize: 11,
      },
      itemWidth: 12,
      itemHeight: 8,
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
        name: series[0].name,
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: pairs0,
        itemStyle: { color: colors0.line },
        lineStyle: { color: colors0.line, width: 2 },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: colors0.areaStart },
              { offset: 1, color: colors0.areaEnd },
            ],
          },
        },
      },
      {
        name: series[1].name,
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: pairs1,
        itemStyle: { color: colors1.line },
        lineStyle: { color: colors1.line, width: 2 },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: colors1.areaStart },
              { offset: 1, color: colors1.areaEnd },
            ],
          },
        },
      },
    ],
  };
}

export default memo(function DualSeriesChart({
  title,
  series,
  yAxisMode,
  formatValue,
}: DualSeriesChartProps) {
  const { general, docker } = useSettings();
  const windowMs = docker.chartWindowSeconds * 1000;
  const option = useMemo(
    () => getChartOption(series, yAxisMode, formatValue, general.use12HourTime, windowMs),
    [series, yAxisMode, formatValue, general.use12HourTime, windowMs],
  );
  const chartRef = useRef<ReactECharts>(null);

  useEChartTimeScroll(chartRef, windowMs);

  return (
    <Paper elevation={0} className="rounded-sm p-3 !bg-[var(--mui-palette-background-chartBg)]">
      <Typography variant="body2" className="mb-1 font-medium">
        {title}
      </Typography>
      <div className="h-40">
        <ReactECharts
          ref={chartRef}
          option={option}
          className="h-full w-full"
          opts={{ renderer: 'canvas' }}
          notMerge={false}
          lazyUpdate={true}
        />
      </div>
    </Paper>
  );
});
