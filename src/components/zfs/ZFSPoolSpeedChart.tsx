import { useRef } from 'react';
import { Paper, Typography } from '@mui/material';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { formatBytes } from '@/formatters/metrics';
import { useGeneralSettings } from '@/hooks/useSettings';
import { useEChartTimeScroll } from '@/hooks/useEChartTimeScroll';
import { resolveChartColors, resolveChartChromeColors } from '@/lib/charts/css-vars';
import { calculateCleanYAxis } from '@/lib/charts/y-axis';

interface TimeSeriesDataPoint {
  timestamp: number;
  readBytesPerSec: number;
  writeBytesPerSec: number;
}

interface ZFSPoolSpeedChartProps {
  poolName: string;
  dataPoints: TimeSeriesDataPoint[];
}

const WINDOW_MS = 60_000;

function getChartOption(dataPoints: TimeSeriesDataPoint[], use12HourTime: boolean): EChartsOption {
  const now = Date.now();
  const readPairs = dataPoints.map((d) => [d.timestamp, d.readBytesPerSec] as [number, number]);
  const writePairs = dataPoints.map((d) => [d.timestamp, d.writeBytesPerSec] as [number, number]);

  const maxValue = Math.max(
    ...dataPoints.map((d) => d.readBytesPerSec),
    ...dataPoints.map((d) => d.writeBytesPerSec),
    0,
  );
  const { max: yAxisMax, interval: yAxisInterval } = calculateCleanYAxis(maxValue, 'bytes');

  const readColors = resolveChartColors('--chart-read');
  const writeColors = resolveChartColors('--chart-write');
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
        const paramArray = params as {
          value: [number, number];
          marker: string;
          seriesName: string;
        }[];
        const ts = paramArray[0]?.value?.[0];
        const time = ts ? new Date(ts).toLocaleTimeString([], timeFormatOpts) : '';
        const lines = paramArray.map(
          (p) => `${p.marker} ${p.seriesName}: ${formatBytes(p.value[1], true)}`
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
      min: now - WINDOW_MS,
      max: now,
      splitNumber: 4,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        show: true,
        color: chrome.textMuted,
        fontSize: 10,
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
        fontSize: 10,
        formatter: (value: number) => formatBytes(value, true, false),
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
        name: 'Read',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: readPairs,
        lineStyle: { color: readColors.line, width: 2 },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: readColors.areaStart },
              { offset: 1, color: readColors.areaEnd },
            ],
          },
        },
      },
      {
        name: 'Write',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: writePairs,
        lineStyle: { color: writeColors.line, width: 2 },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: writeColors.areaStart },
              { offset: 1, color: writeColors.areaEnd },
            ],
          },
        },
      },
    ],
  };
}

export default function ZFSPoolSpeedChart({
  poolName,
  dataPoints,
}: ZFSPoolSpeedChartProps) {
  const { general } = useGeneralSettings();
  const option = getChartOption(dataPoints, general.use12HourTime);
  const chartRef = useRef<ReactECharts>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEChartTimeScroll(chartRef, WINDOW_MS, wrapperRef);

  return (
    <Paper elevation={0} className="rounded-sm p-4 bg-(--mui-palette-background-chartBg)">
      <Typography variant="subtitle2" className="mb-2">
        {poolName}
      </Typography>
      <div ref={wrapperRef} className="h-48">
        <ReactECharts
          ref={chartRef}
          option={option}
          style={{ height: '100%', width: '100%' }}
          opts={{ renderer: 'canvas' }}
          notMerge={false}
          lazyUpdate={true}
        />
      </div>
    </Paper>
  );
}
