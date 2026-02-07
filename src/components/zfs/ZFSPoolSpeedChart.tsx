import { Sheet, Typography } from '@mui/joy';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import type { TimeSeriesDataPoint } from '@/hooks/useTimeSeriesBuffer';
import { formatBytes } from '@/formatters/metrics';

interface ZFSPoolSpeedChartProps {
  poolName: string;
  dataPoints: TimeSeriesDataPoint[];
}

// Get CSS variable value from computed styles
function getCssVar(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function getChartOption(dataPoints: TimeSeriesDataPoint[]): EChartsOption {
  const timestamps = dataPoints.map((d) =>
    new Date(d.timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  );
  const readData = dataPoints.map((d) => d.readBytesPerSec);
  const writeData = dataPoints.map((d) => d.writeBytesPerSec);

  // Use chart CSS variables defined in App.css
  const readColor = getCssVar('--chart-read');
  const readAreaStart = getCssVar('--chart-read-area-start');
  const readAreaEnd = getCssVar('--chart-read-area-end');
  const writeColor = getCssVar('--chart-write');
  const writeAreaStart = getCssVar('--chart-write-area-start');
  const writeAreaEnd = getCssVar('--chart-write-area-end');
  const textMuted = getCssVar('--chart-text-muted');
  const borderColor = getCssVar('--chart-border');
  const tooltipBg = getCssVar('--chart-tooltip-bg');
  const tooltipText = getCssVar('--chart-tooltip-text');

  return {
    animation: true,
    animationDuration: 0,
    animationDurationUpdate: 850,
    animationEasingUpdate: 'linear',
    grid: {
      top: 10,
      right: 15,
      bottom: 45,
      left: 55,
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: tooltipBg,
      borderColor: borderColor,
      textStyle: {
        color: tooltipText,
        fontSize: 12,
      },
      formatter: (params: unknown) => {
        const paramArray = params as {
          axisValue: string;
          marker: string;
          seriesName: string;
          value: number;
        }[];
        const time = paramArray[0]?.axisValue || '';
        const lines = paramArray.map(
          (p) => `${p.marker} ${p.seriesName}: ${formatBytes(p.value, true)}`
        );
        return `${time}<br/>${lines.join('<br/>')}`;
      },
    },
    legend: {
      show: true,
      bottom: 0,
      textStyle: {
        color: textMuted,
        fontSize: 11,
      },
      itemWidth: 12,
      itemHeight: 8,
    },
    xAxis: {
      type: 'category',
      data: timestamps,
      boundaryGap: false,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        show: true,
        interval: 'auto',
        color: textMuted,
        fontSize: 10,
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: textMuted,
        fontSize: 10,
        formatter: (value: number) => formatBytes(value, true),
      },
      splitLine: {
        lineStyle: {
          color: borderColor,
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
        data: readData,
        lineStyle: { color: readColor, width: 2 },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: readAreaStart },
              { offset: 1, color: readAreaEnd },
            ],
          },
        },
      },
      {
        name: 'Write',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: writeData,
        lineStyle: { color: writeColor, width: 2 },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: writeAreaStart },
              { offset: 1, color: writeAreaEnd },
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
  const option = getChartOption(dataPoints);

  return (
    <Sheet variant="outlined" className="rounded-sm p-4">
      <Typography level="title-sm" className="mb-2">
        {poolName}
      </Typography>
      <div className="h-48">
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
}
