import { memo, useMemo, useRef, useEffect, useCallback, useState } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import ReactECharts from 'echarts-for-react';
import { useGeneralSettings } from '@/hooks/useSettings';
import HorizontalScrollRow from '@/components/shared/HorizontalScrollRow';
import { RANGE_PRESETS, TIMELINE_METRICS, getTimelineOption } from '@/lib/charts/timeline-chart-config';
import type { DockerStatsRow } from '@/types/docker';
import type { MetricType } from '@/components/docker/MetricCheckboxes';

interface HistoricalTimelineProps {
  timelineData: DockerStatsRow[];
  initialFrom: number;
  initialTo: number;
  onRangeChange: (from: number, to: number) => void;
  timelineFrom: number;
  timelineTo: number;
  activePresetMs: number | null;
  onPresetChange: (ms: number) => void;
  onCustomRangeChange: (from: number, to: number) => void;
}

export default memo(function HistoricalTimeline({
  timelineData,
  initialFrom,
  initialTo,
  onRangeChange,
  timelineFrom,
  timelineTo,
  activePresetMs,
  onPresetChange,
  onCustomRangeChange,
}: HistoricalTimelineProps) {
  const { general } = useGeneralSettings();
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
      // Time axis may return date strings - coerce to numeric timestamps.
      // Slider drags produce interpolated floats; round to integer ms so the
      // server-side schema (which requires int ms) doesn't reject the query.
      const from = typeof zoom.startValue === 'string' ? new Date(zoom.startValue).getTime() : zoom.startValue;
      const to = typeof zoom.endValue === 'string' ? new Date(zoom.endValue).getTime() : zoom.endValue;
      if (isNaN(from) || isNaN(to)) return;
      onRangeChange(Math.round(from), Math.round(to));
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

  // Custom date picker handlers - reset slider to full range on change
  const resetSlider = useCallback(() => {
    suppressZoomRef.current = true;
    const instance = chartRef.current?.getEchartsInstance();
    if (instance) {
      instance.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
    }
  }, []);

  const handleFromChange = useCallback((ms: number) => {
    if (ms >= timelineTo) return;
    onCustomRangeChange(ms, timelineTo);
    resetSlider();
  }, [timelineTo, onCustomRangeChange, resetSlider]);

  const handleToChange = useCallback((ms: number) => {
    if (ms <= timelineFrom) return;
    onCustomRangeChange(timelineFrom, ms);
    resetSlider();
  }, [timelineFrom, onCustomRangeChange, resetSlider]);

  // Find closest matching preset for highlight
  const activeRangeValue = activePresetMs != null
    ? RANGE_PRESETS.find((p) => p.ms === activePresetMs)
    : undefined;

  return (
    <div className="border-t border-(--border) bg-(--card) px-4 py-3 shrink-0">
      <div className="mb-2">
        <HorizontalScrollRow
          bgVar="--card"
          innerClassName="flex flex-nowrap items-center gap-3 min-w-full"
          scrollClassName="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <ToggleGroup
            value={activeRangeValue ? [String(activeRangeValue.ms)] : []}
            onValueChange={(vals) => {
              const v = vals[0];
              if (v != null) handlePreset(Number(v));
            }}
            className="shrink-0"
          >
            {RANGE_PRESETS.map((preset) => (
              <ToggleGroupItem key={preset.label} value={String(preset.ms)}>
                {preset.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-(--muted-foreground)">From:</span>
            <DateTimePicker
              value={timelineFrom}
              onChange={handleFromChange}
              max={timelineTo}
              use12Hour={general.use12HourTime}
              ariaLabel="From date and time"
            />
            <span className="text-xs text-(--muted-foreground)">To:</span>
            <DateTimePicker
              value={timelineTo}
              onChange={handleToChange}
              min={timelineFrom}
              use12Hour={general.use12HourTime}
              ariaLabel="To date and time"
            />
          </div>

          <ToggleGroup
            value={[timelineMetric]}
            onValueChange={(vals) => {
              const v = vals[0];
              if (v != null) setTimelineMetric(v as MetricType);
            }}
            className="shrink-0 ml-auto"
          >
            {TIMELINE_METRICS.map((metric) => (
              <ToggleGroupItem key={metric.key} value={metric.key}>
                {metric.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </HorizontalScrollRow>
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
