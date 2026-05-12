import { memo, useMemo, useRef, useEffect, useCallback, useState } from 'react';
import { Typography, ToggleButtonGroup, ToggleButton } from '@mui/material';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import ReactECharts from 'echarts-for-react';
import { useGeneralSettings } from '@/hooks/useSettings';
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
      // Time axis may return date strings - coerce to numeric timestamps
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

  // Custom date picker handlers - reset slider to full range on change
  const resetSlider = useCallback(() => {
    suppressZoomRef.current = true;
    const instance = chartRef.current?.getEchartsInstance();
    if (instance) {
      instance.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
    }
  }, []);

  const handleFromChange = useCallback((value: Dayjs | null) => {
    if (!value || !value.isValid()) return;
    const ms = value.valueOf();
    if (ms >= timelineTo) return;
    onCustomRangeChange(ms, timelineTo);
    resetSlider();
  }, [timelineTo, onCustomRangeChange, resetSlider]);

  const handleToChange = useCallback((value: Dayjs | null) => {
    if (!value || !value.isValid()) return;
    const ms = value.valueOf();
    if (ms <= timelineFrom) return;
    onCustomRangeChange(timelineFrom, ms);
    resetSlider();
  }, [timelineFrom, onCustomRangeChange, resetSlider]);

  // Find closest matching preset for highlight
  const activeRangeValue = activePresetMs != null
    ? RANGE_PRESETS.find((p) => p.ms === activePresetMs)
    : undefined;

  const dateTimeFormat = general.use12HourTime ? 'MM/DD/YYYY hh:mm A' : 'MM/DD/YYYY HH:mm';

  return (
    <div className="sticky bottom-0 z-10 border-t border-neutral-200 dark:border-neutral-700 bg-(--mui-palette-background-paper) px-4 py-3">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Typography variant="caption" className="text-neutral-500">Range:</Typography>
          <ToggleButtonGroup
            value={activeRangeValue ? String(activeRangeValue.ms) : null}
            onChange={(_e, newValue) => {
              if (newValue !== null) handlePreset(Number(newValue));
            }}
            size="small"
            exclusive
          >
            {RANGE_PRESETS.map((preset) => (
              <ToggleButton key={preset.label} value={String(preset.ms)}>
                {preset.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </div>

        <LocalizationProvider dateAdapter={AdapterDayjs}>
          <div className="flex items-center gap-2">
            <Typography variant="caption" className="text-neutral-500">From:</Typography>
            <DateTimePicker
              value={dayjs(timelineFrom)}
              onChange={handleFromChange}
              maxDateTime={dayjs(timelineTo)}
              ampm={general.use12HourTime}
              format={dateTimeFormat}
              slotProps={{
                textField: { size: 'small' },
              }}
            />
            <Typography variant="caption" className="text-neutral-500">To:</Typography>
            <DateTimePicker
              value={dayjs(timelineTo)}
              onChange={handleToChange}
              minDateTime={dayjs(timelineFrom)}
              ampm={general.use12HourTime}
              format={dateTimeFormat}
              slotProps={{
                textField: { size: 'small' },
              }}
            />
          </div>
        </LocalizationProvider>

        <div className="ml-auto flex items-center gap-2">
          <Typography variant="caption" className="text-neutral-500">Metric:</Typography>
          <ToggleButtonGroup
            value={timelineMetric}
            onChange={(_e, newValue) => {
              if (newValue !== null) setTimelineMetric(newValue as MetricType);
            }}
            size="small"
            exclusive
          >
            {TIMELINE_METRICS.map((metric) => (
              <ToggleButton key={metric.key} value={metric.key}>
                {metric.label}
              </ToggleButton>
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
