import { memo, useMemo, useRef, useEffect, useCallback, useState } from 'react';
import { Button, ToggleButtonGroup, Typography } from '@mui/joy';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { useSettings } from '@/hooks/useSettings';
import { resolveChartColors, resolveChartChromeColors } from '@/lib/charts/css-vars';
import type { DockerStatsRow } from '@/types/docker';
import type { MetricType } from '@/components/docker/MetricCheckboxes';

interface HistoricalTimelineProps {
  timelineData: DockerStatsRow[];
  initialFrom: number;
  initialTo: number;
  onRangeChange: (from: number, to: number) => void;
  timelineRangeMs: number;
  onPresetChange: (ms: number) => void;
}

const RANGE_PRESETS = [
  { label: '1h', ms: 3_600_000 },
  { label: '6h', ms: 21_600_000 },
  { label: '12h', ms: 43_200_000 },
  { label: '1d', ms: 86_400_000 },
  { label: '3d', ms: 259_200_000 },
  { label: '7d', ms: 604_800_000 },
  { label: '30d', ms: 2_592_000_000 },
] as const;

const TIMELINE_METRICS: { key: MetricType; label: string; colorVar: string; extract: (r: DockerStatsRow) => number }[] = [
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
function getTimelineOption(
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

export default memo(function HistoricalTimeline({
  timelineData,
  initialFrom,
  initialTo,
  onRangeChange,
  timelineRangeMs,
  onPresetChange,
}: HistoricalTimelineProps) {
  const { general } = useSettings();
  const chartRef = useRef<ReactECharts>(null);
  const initializedRef = useRef(false);
  const suppressZoomRef = useRef(false);

  const [timelineMetric, setTimelineMetric] = useState<MetricType>('cpu');

  const activeMetricConfig = TIMELINE_METRICS.find((m) => m.key === timelineMetric)!;

  const seriesData = useMemo<[number, number][]>(
    () => timelineData.map((row) => [new Date(row.time).getTime(), activeMetricConfig.extract(row)]),
    [timelineData, activeMetricConfig],
  );

  const option = useMemo(
    () => getTimelineOption(seriesData, activeMetricConfig.colorVar, general.use12HourTime),
    [seriesData, activeMetricConfig.colorVar, general.use12HourTime],
  );

  // Set initial slider position once after mount
  useEffect(() => {
    if (initializedRef.current) return;
    const instance = chartRef.current?.getEchartsInstance();
    if (!instance || seriesData.length === 0) return;
    initializedRef.current = true;
    instance.dispatchAction({
      type: 'dataZoom',
      startValue: initialFrom,
      endValue: initialTo,
    });
  }, [seriesData, initialFrom, initialTo]);

  const onEvents = useMemo(() => ({
    datazoom: () => {
      if (suppressZoomRef.current) {
        suppressZoomRef.current = false;
        return;
      }
      const instance = chartRef.current?.getEchartsInstance();
      if (!instance) return;
      const opt = instance.getOption() as { dataZoom: { startValue: string | number; endValue: string | number }[] };
      const zoom = opt.dataZoom?.[0];
      if (!zoom || zoom.startValue == null || zoom.endValue == null) return;
      // Time axis may return date strings — coerce to numeric timestamps
      const from = typeof zoom.startValue === 'string' ? new Date(zoom.startValue).getTime() : zoom.startValue;
      const to = typeof zoom.endValue === 'string' ? new Date(zoom.endValue).getTime() : zoom.endValue;
      if (isNaN(from) || isNaN(to)) return;
      onRangeChange(from, to);
    },
  }), [onRangeChange]);

  // Preset: notify parent (triggers data refetch) + reset slider to full range
  // suppressZoomRef is consumed (reset to false) by the datazoom handler above
  const handlePreset = useCallback((ms: number) => {
    onPresetChange(ms);
    suppressZoomRef.current = true;
    const instance = chartRef.current?.getEchartsInstance();
    if (instance) {
      instance.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
    }
  }, [onPresetChange]);

  // Find closest matching preset for highlight (tolerance handles URL-restored ranges)
  const activeRangeValue = RANGE_PRESETS.find(
    (p) => Math.abs(timelineRangeMs - p.ms) / p.ms < 0.05,
  );

  return (
    <div className="sticky bottom-0 z-10 border-t border-neutral-200 dark:border-neutral-700 bg-[var(--joy-palette-background-surface)] px-4 py-3">
      <div className="flex items-center gap-3 mb-2">
        <div className="flex items-center gap-2">
          <Typography level="body-xs" className="text-neutral-500">Range:</Typography>
          <ToggleButtonGroup
            value={activeRangeValue ? String(activeRangeValue.ms) : null}
            onChange={(_e, newValue) => {
              if (newValue !== null) handlePreset(Number(newValue));
            }}
            size="sm"
            variant="outlined"
          >
            {RANGE_PRESETS.map((preset) => (
              <Button key={preset.label} value={String(preset.ms)}>
                {preset.label}
              </Button>
            ))}
          </ToggleButtonGroup>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Typography level="body-xs" className="text-neutral-500">Metric:</Typography>
          <ToggleButtonGroup
            value={timelineMetric}
            onChange={(_e, newValue) => {
              if (newValue !== null) setTimelineMetric(newValue as MetricType);
            }}
            size="sm"
            variant="outlined"
          >
            {TIMELINE_METRICS.map((metric) => (
              <Button key={metric.key} value={metric.key}>
                {metric.label}
              </Button>
            ))}
          </ToggleButtonGroup>
        </div>
      </div>
      <div className="h-[160px]">
        <ReactECharts
          ref={chartRef}
          option={option}
          style={{ height: '100%', width: '100%' }}
          opts={{ renderer: 'canvas' }}
          notMerge={false}
          lazyUpdate={true}
          onEvents={onEvents}
        />
      </div>
    </div>
  );
});
