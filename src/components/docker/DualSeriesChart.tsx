import { memo, useRef } from 'react';
import { Paper, Typography } from '@mui/material';
import type ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { useDockerSettings, useGeneralSettings } from '@/hooks/useSettings';
import { useEChartTimeScroll } from '@/hooks/useEChartTimeScroll';
import { resolveChartColors, resolveChartChromeColors, type ChartChromeColors } from '@/lib/charts/css-vars';
import { calculateCleanYAxis, type YAxisMode } from '@/lib/charts/y-axis';
import DualSeriesChartRenderer from '@/components/docker/DualSeriesChartRenderer';

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
  chrome: ChartChromeColors,
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

  const timeFormatOpts: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: use12HourTime,
  };

  return {
    animation: false,
    grid: {
      top: 6,
      right: 15,
      bottom: 20,
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
    legend: { show: false },
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
        fontSize: 12,
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
        fontSize: 12,
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
  const { general } = useGeneralSettings();
  const { docker } = useDockerSettings();
  const windowMs = docker.chartWindowSeconds * 1000;
  const chrome = resolveChartChromeColors();
  const option = getChartOption(series, yAxisMode, formatValue, general.use12HourTime, windowMs, chrome);
  const chartRef = useRef<ReactECharts | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEChartTimeScroll(chartRef, windowMs, wrapperRef);

  return (
    <Paper elevation={0} className="h-full flex flex-col rounded-sm p-2 bg-(--mui-palette-background-chartBg)!">
      <div className="flex items-center justify-between mb-0.5 shrink-0">
        <Typography variant="body2" className="font-medium">{title}</Typography>
        <div className="flex gap-3">
          {series.map((s) => {
            const color = resolveChartColors(s.colorVar).line;
            return (
              <span key={s.name} className="flex items-center gap-1 text-xs" style={{ color: chrome.textMuted }}>
                <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                {s.name}
              </span>
            );
          })}
        </div>
      </div>
      <div ref={wrapperRef} className="flex-1 min-h-0">
        <DualSeriesChartRenderer ref={chartRef} option={option} />
      </div>
    </Paper>
  );
});
