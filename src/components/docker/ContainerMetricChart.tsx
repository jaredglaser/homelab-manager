import { memo, useMemo } from 'react';
import { Sheet, Typography } from '@mui/joy';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { useSettings } from '@/hooks/useSettings';

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

// Get CSS variable value from computed styles
function getCssVar(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Nice intervals to choose from (will be scaled by magnitude)
const NICE_INTERVALS = [1, 2, 5, 10, 20, 25, 50, 100];
const TARGET_TICKS = 5;

interface YAxisConfig {
  max: number;
  interval: number;
}

/**
 * Find a "nice" interval that gives us approximately the target number of ticks.
 */
function findNiceInterval(range: number): number {
  const roughInterval = range / TARGET_TICKS;
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughInterval)));
  const normalized = roughInterval / magnitude;

  for (const nice of NICE_INTERVALS) {
    if (nice >= normalized) {
      return nice * magnitude;
    }
  }

  return magnitude * 10;
}

/**
 * Calculate clean y-axis max and interval values.
 */
function calculateCleanYAxis(maxValue: number, isPercent: boolean = false): YAxisConfig {
  if (maxValue <= 0) {
    return isPercent ? { max: 100, interval: 20 } : { max: 100, interval: 20 };
  }

  if (isPercent && maxValue <= 100) {
    // For percentages that fit within 100%, cap there for a clean axis
    const effectiveMax = Math.min(maxValue * 1.1, 100);
    const interval = findNiceInterval(effectiveMax);
    const max = Math.min(Math.ceil(effectiveMax / interval) * interval, 100);
    return { max, interval };
  }

  const interval = findNiceInterval(maxValue);
  const max = Math.ceil(maxValue / interval) * interval;
  return { max, interval };
}

const WINDOW_MS = 60_000;

function getChartOption(
  dataPoints: DataPoint[],
  colorVar: string,
  formatValue: (value: number) => string,
  isPercent: boolean,
  use12HourTime: boolean
): EChartsOption {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const timeValuePairs = dataPoints.map((d) => [d.timestamp, d.value] as [number, number]);
  const values = dataPoints.map((d) => d.value);

  // Extend line to the left edge so only the right side changes
  if (timeValuePairs.length > 0 && timeValuePairs[0][0] > windowStart) {
    timeValuePairs.unshift([windowStart, timeValuePairs[0][1]]);
  }
  const maxValue = Math.max(...values, 0);
  const { max: yAxisMax, interval: yAxisInterval } = calculateCleanYAxis(maxValue, isPercent);

  const lineColor = getCssVar(colorVar);
  const areaStart = getCssVar(`${colorVar}-area-start`);
  const areaEnd = getCssVar(`${colorVar}-area-end`);
  const textMuted = getCssVar('--chart-text-muted');
  const borderColor = getCssVar('--chart-border');
  const tooltipBg = getCssVar('--chart-tooltip-bg');
  const tooltipText = getCssVar('--chart-tooltip-text');

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
      backgroundColor: tooltipBg,
      borderColor: borderColor,
      textStyle: {
        color: tooltipText,
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
        color: textMuted,
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
        color: textMuted,
        fontSize: 9,
        formatter: (value: number) => formatValue(value),
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
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: timeValuePairs,
        lineStyle: { color: lineColor, width: 2 },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: areaStart },
              { offset: 1, color: areaEnd },
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

  return (
    <Sheet variant="soft" className="rounded-sm p-3">
      <Typography level="body-sm" className="mb-1 font-medium">
        {title}
      </Typography>
      <div className="h-32">
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
