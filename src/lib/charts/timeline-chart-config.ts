import type { EChartsOption } from 'echarts';
import { resolveChartColors, resolveChartChromeColors } from '@/lib/charts/css-vars';
import type { DockerStatsRow } from '@/types/docker';
import type { MetricType } from '@/components/docker/MetricCheckboxes';

export const RANGE_PRESETS = [
  { label: '1h', ms: 3_600_000 },
  { label: '6h', ms: 21_600_000 },
  { label: '12h', ms: 43_200_000 },
  { label: '1d', ms: 86_400_000 },
  { label: '3d', ms: 259_200_000 },
  { label: '7d', ms: 604_800_000 },
  { label: '30d', ms: 2_592_000_000 },
] as const;

export const TIMELINE_METRICS: { key: MetricType; label: string; colorVar: string; extract: (r: DockerStatsRow) => number }[] = [
  { key: 'cpu', label: 'CPU', colorVar: '--chart-cpu', extract: (r) => r.cpu_percent ?? 0 },
  { key: 'memory', label: 'Mem', colorVar: '--chart-memory', extract: (r) => r.memory_percent ?? 0 },
  { key: 'blockRead', label: 'Blk R', colorVar: '--chart-read', extract: (r) => r.block_io_read_bytes_per_sec ?? 0 },
  { key: 'blockWrite', label: 'Blk W', colorVar: '--chart-write', extract: (r) => r.block_io_write_bytes_per_sec ?? 0 },
  { key: 'networkRx', label: 'Net RX', colorVar: '--chart-read', extract: (r) => r.network_rx_bytes_per_sec ?? 0 },
  { key: 'networkTx', label: 'Net TX', colorVar: '--chart-write', extract: (r) => r.network_tx_bytes_per_sec ?? 0 },
];

/**
 * Build an ECharts option object configured for a time-series timeline chart.
 *
 * Produces an option with a time x-axis (labels switch to month/day for ranges > 24h and respect `use12HourTime`), a hidden y-axis with minimum 0, two dataZoom controls (inside and external), and a single smoothed line series with gradient area fill and themed colors resolved from `colorVar`.
 *
 * @param seriesData - Array of `[timestamp, value]` pairs where `timestamp` is milliseconds since the Unix epoch and `value` is the metric value
 * @param colorVar - CSS color variable name used to resolve line and area colors
 * @param use12HourTime - If true, format time labels using a 12-hour clock; otherwise use 24-hour formatting
 * @returns The configured `EChartsOption` for rendering the timeline series
 */
export function getTimelineOption(
  seriesData: [number, number][],
  colorVar: string,
  use12HourTime: boolean,
): EChartsOption {
  const seriesColors = resolveChartColors(colorVar);
  const chrome = resolveChartChromeColors();
  const dataMin = seriesData.length > 0 ? seriesData[0][0] : Date.now() - 3_600_000;
  const dataMax = seriesData.length > 0 ? seriesData[seriesData.length - 1][0] : Date.now();
  const rangeMs = dataMax - dataMin;

  return {
    animation: false,
    grid: { top: 10, right: 15, bottom: 80, left: 55 },
    xAxis: {
      type: 'time',
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        show: true,
        color: chrome.textMuted,
        fontSize: 10,
        hideOverlap: true,
        formatter: (value: number) => {
          const d = new Date(value);
          if (rangeMs > 86_400_000) {
            return `${d.toLocaleString([], { month: 'short' })} ${d.getDate()}`;
          }
          return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: use12HourTime });
        },
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      min: 0,
      show: false,
    },
    dataZoom: [
      {
        type: 'inside',
        start: 0,
        end: 100,
      },
      {
        start: 0,
        end: 100,
      },
    ],
    series: [
      {
        type: 'line',
        smooth: true,
        showSymbol: false,
        sampling: 'lttb',
        data: seriesData,
        lineStyle: { color: seriesColors.line, width: 1 },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 0, y2: 1,
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
