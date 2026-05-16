import { memo, useMemo, useRef } from 'react';
import type ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { useGeneralSettings } from '@/hooks/useSettings';
import { useDockerSettings } from '@/hooks/useDockerSettings';
import { useEChartTimeScroll } from '@/hooks/useEChartTimeScroll';
import { resolveChartColors, resolveChartChromeColors, type ChartChromeColors } from '@/lib/charts/css-vars';
import DualSeriesChartRenderer from '@/components/docker/DualSeriesChartRenderer';
import HorizontalScrollRow from '@/components/shared/HorizontalScrollRow';
import { formatAsPercent, formatBytes, formatBitsSIUnits } from '@/formatters/metrics';
import type { ChartDataPoint } from '@/hooks/useContainerChartData';

export type MetricKey = 'cpu' | 'memory' | 'blockRead' | 'blockWrite' | 'networkRx' | 'networkTx';

interface MetricDef {
  key: MetricKey;
  label: string;
  colorVar: string;
  format: (v: number) => string;
  extract: (d: ChartDataPoint) => number;
}

const METRIC_DEFS: MetricDef[] = [
  {
    key: 'cpu',
    label: 'CPU',
    colorVar: '--chart-cpu',
    format: (v) => formatAsPercent(v / 100),
    extract: (d) => d.cpuPercent,
  },
  {
    key: 'memory',
    label: 'Memory',
    colorVar: '--chart-memory',
    format: (v) => formatAsPercent(v / 100),
    extract: (d) => d.memoryPercent,
  },
  {
    key: 'blockRead',
    label: 'Block Read',
    colorVar: '--chart-read',
    format: (v) => formatBytes(v, true),
    extract: (d) => d.blockIoReadBytesPerSec,
  },
  {
    key: 'blockWrite',
    label: 'Block Write',
    colorVar: '--chart-write',
    format: (v) => formatBytes(v, true),
    extract: (d) => d.blockIoWriteBytesPerSec,
  },
  {
    key: 'networkRx',
    label: 'Net RX',
    colorVar: '--chart-read',
    format: (v) => formatBitsSIUnits(v * 8, true),
    extract: (d) => d.networkRxBytesPerSec,
  },
  {
    key: 'networkTx',
    label: 'Net TX',
    colorVar: '--chart-write',
    format: (v) => formatBitsSIUnits(v * 8, true),
    extract: (d) => d.networkTxBytesPerSec,
  },
];

// Compile-time check: every MetricKey must have a MetricDef entry.
// satisfies (not `as`) means tsc errors if a MetricKey is absent from METRIC_DEFS.
const _exhaustiveMetricDefs = {
  cpu: true,
  memory: true,
  blockRead: true,
  blockWrite: true,
  networkRx: true,
  networkTx: true,
} satisfies Record<MetricKey, true>;
void _exhaustiveMetricDefs;

interface ContainerMetricsChartProps {
  dataPoints: ChartDataPoint[];
  active: Set<MetricKey>;
  onToggle: (key: MetricKey) => void;
  windowMs?: number;
}

function buildOption(
  dataPoints: ChartDataPoint[],
  active: Set<MetricKey>,
  windowMs: number,
  chrome: ChartChromeColors,
  use12HourTime: boolean,
): EChartsOption {
  const now = Date.now();
  const activeMetrics = METRIC_DEFS.filter((m) => active.has(m.key));

  // One hidden y-axis per active series gives each metric its own scale,
  // so CPU%, memory%, bytes/s and bits/s coexist on one canvas without normalization.
  const yAxis = activeMetrics.map(() => ({
    type: 'value' as const,
    show: false,
    scale: true,
  }));

  const timeFormatOpts: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: use12HourTime,
  };

  const series = activeMetrics.map((metric, idx) => {
    const colors = resolveChartColors(metric.colorVar);
    const data = dataPoints.map((d) => [d.timestamp, metric.extract(d)] as [number, number]);
    return {
      id: metric.key,
      name: metric.label,
      type: 'line' as const,
      smooth: true,
      showSymbol: false,
      yAxisIndex: idx,
      data,
      itemStyle: { color: colors.line },
      lineStyle: {
        color: colors.line,
        width: 2,
      },
      areaStyle: {
        color: {
          type: 'linear' as const,
          x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: colors.areaStart },
            { offset: 1, color: colors.areaEnd },
          ],
        },
      },
    };
  });

  return {
    animation: false,
    grid: { top: 6, right: 12, bottom: 20, left: 30 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: chrome.tooltipBg,
      borderColor: chrome.border,
      textStyle: { color: chrome.tooltipText, fontSize: 11 },
      formatter: (params: unknown) => {
        const paramArray = params as { value: [number, number]; marker: string; seriesName: string }[];
        const ts = paramArray[0]?.value?.[0];
        const time = ts ? new Date(ts).toLocaleTimeString([], timeFormatOpts) : '';
        const metricByLabel = Object.fromEntries(METRIC_DEFS.map((m) => [m.label, m]));
        const lines = paramArray.map((p) => {
          const def = metricByLabel[p.seriesName];
          const formatted = def ? def.format(p.value[1]) : String(p.value[1]);
          return `${p.marker} ${p.seriesName}: ${formatted}`;
        });
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
        fontSize: 11,
        formatter: (value: number) => {
          const d = new Date(value);
          return `${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
        },
      },
      splitLine: { show: false },
    },
    yAxis: yAxis.length ? yAxis : [{ type: 'value', show: false }],
    series,
  };
}

function LegendChip({
  metric,
  isActive,
  currentValue,
  onToggle,
}: {
  metric: MetricDef;
  isActive: boolean;
  currentValue: number;
  onToggle: () => void;
}) {
  const colors = resolveChartColors(metric.colorVar);
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex shrink-0 items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap transition-all cursor-pointer"
      style={{
        border: isActive && colors.line ? `1px solid ${colors.line}` : '1px solid var(--mui-palette-divider)',
        background: isActive ? (colors.line ? `color-mix(in srgb, ${colors.line} 12%, transparent)` : 'transparent') : 'transparent',
        color: isActive ? 'var(--mui-palette-text-primary)' : 'var(--mui-palette-text-disabled)',
      }}
    >
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{
          background: isActive ? (colors.line || 'var(--mui-palette-divider)') : 'var(--mui-palette-text-disabled)',
        }}
      />
      <span>{metric.label}</span>
      {isActive && (
        <span className="font-mono text-[10px] opacity-80 ml-0.5 tabular-nums">
          {metric.format(currentValue)}
        </span>
      )}
    </button>
  );
}

export default memo(function ContainerMetricsChart({
  dataPoints,
  active,
  onToggle,
  windowMs: windowMsProp,
}: ContainerMetricsChartProps) {
  const { general } = useGeneralSettings();
  const { docker } = useDockerSettings();
  const windowMs = windowMsProp ?? docker.chartWindowSeconds * 1000;
  const chrome = resolveChartChromeColors();

  const option = useMemo(
    () => buildOption(dataPoints, active, windowMs, chrome, general.use12HourTime),
    // resolveChartChromeColors() reads getComputedStyle on every call and returns a new object,
    // so chrome is never reference-stable. Omitting it is safe: theme changes also cause
    // parent re-renders which update dataPoints, triggering a memo recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataPoints, active, windowMs, general.use12HourTime],
  );

  const chartRef = useRef<ReactECharts | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  useEChartTimeScroll(chartRef, windowMs, wrapperRef);

  const currentValues = useMemo(() => {
    const last = dataPoints.at(-1);
    if (!last) return {} as Record<MetricKey, number>;
    return Object.fromEntries(METRIC_DEFS.map((m) => [m.key, m.extract(last)])) as Record<MetricKey, number>;
  }, [dataPoints]);

  return (
    <div className="flex flex-col h-full rounded-sm overflow-hidden bg-(--mui-palette-background-chartBg)">
      <div ref={wrapperRef} className="flex-1 min-h-0">
        <DualSeriesChartRenderer ref={chartRef} option={option} />
      </div>
      <div className="border-t border-(--mui-palette-divider) shrink-0">
        <HorizontalScrollRow bgVar="--mui-palette-background-chartBg">
          {METRIC_DEFS.map((m) => (
            <LegendChip
              key={m.key}
              metric={m}
              isActive={active.has(m.key)}
              currentValue={currentValues[m.key] ?? 0}
              onToggle={() => onToggle(m.key)}
            />
          ))}
        </HorizontalScrollRow>
      </div>
    </div>
  );
});
