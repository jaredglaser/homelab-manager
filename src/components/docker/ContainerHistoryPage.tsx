import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Typography, CircularProgress } from '@mui/joy';
import { ArrowLeft } from 'lucide-react';
import { getContainerHistory, getContainerInfo } from '@/data/docker.functions';
import { getIconUrl, FALLBACK_ICON_URL } from '@/lib/utils/icon-resolver';
import MetricCheckboxes, { type MetricType } from '@/components/docker/MetricCheckboxes';
import HistoricalChartsGrid from '@/components/docker/HistoricalChartsGrid';
import HistoricalTimeline from '@/components/docker/HistoricalTimeline';

interface ContainerHistoryPageProps {
  containerId: string;
  host?: string;
  initialMetrics: string;
  initialFrom?: number;
  initialTo?: number;
}

/**
 * Parse a comma-separated metrics string into a set of recognized metric keys.
 *
 * @param metricsStr - Comma-separated metric identifiers (e.g. "cpu,memory,networkRx")
 * @returns A set containing the parsed `MetricType` values; if the input contains no valid metrics, returns a set with `cpu` and `memory`
 */
function parseMetrics(metricsStr: string): Set<MetricType> {
  const valid: MetricType[] = ['cpu', 'memory', 'blockRead', 'blockWrite', 'networkRx', 'networkTx'];
  const parsed = metricsStr.split(',').filter((m): m is MetricType => valid.includes(m as MetricType));
  return new Set(parsed.length > 0 ? parsed : ['cpu', 'memory']);
}

const DEFAULT_RANGE_MS = 3_600_000; // 1 hour
const CHART_DEBOUNCE_MS = 800;

/**
 * Page component that displays a container's historical metrics with a timeline, selectable metrics, and detailed charts.
 *
 * Renders a header with container info and metric controls, a chart area showing selected metrics for a debounced sub-range, and a sticky timeline for preset ranges and range selection. Fetches timeline and chart data, debounces slider updates, optionally auto-refreshes when the range includes "now", and keeps the URL search params synchronized with the current metrics and range.
 *
 * @param containerId - ID of the container to display
 * @param host - Optional host identifier used for data requests
 * @param initialMetrics - Comma-separated metrics string used to initialize selected metrics
 * @param initialFrom - Optional initial start time (ms since epoch) for the visible range
 * @param initialTo - Optional initial end time (ms since epoch) for the visible range
 * @returns The rendered ContainerHistoryPage element
 */
export default function ContainerHistoryPage({
  containerId,
  host,
  initialMetrics,
  initialFrom,
  initialTo,
}: ContainerHistoryPageProps) {
  const navigate = useNavigate({ from: '/docker/$containerId' });

  const now = useRef(Date.now()).current;
  const initialRange = useRef({
    from: initialFrom ?? now - DEFAULT_RANGE_MS,
    to: initialTo ?? now,
  }).current;

  // Timeline range driven by presets — determines what data the timeline fetches
  const [timelineRangeMs, setTimelineRangeMs] = useState(() =>
    initialFrom !== undefined && initialTo !== undefined
      ? initialTo - initialFrom
      : DEFAULT_RANGE_MS,
  );

  // Debounced range drives chart query — updated after 800ms of slider idle
  const [debouncedRange, setDebouncedRange] = useState(initialRange);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Metric selection state
  const [selectedMetrics, setSelectedMetrics] = useState<Set<MetricType>>(
    () => parseMetrics(initialMetrics),
  );

  // ─── Stream 1: Timeline data for the current preset range ───
  // Query key includes timelineRangeMs so presets trigger a refetch.
  // queryFn uses Date.now() so periodic refetches pick up fresh data.
  const timelineQuery = useQuery({
    queryKey: ['container-timeline', host, containerId, timelineRangeMs],
    queryFn: () => getContainerHistory({
      data: {
        containerId,
        host,
        fromMs: Date.now() - timelineRangeMs,
        toMs: Date.now(),
        targetPoints: 2000,
      },
    }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  // Fetch container info (name, image, icon)
  const infoQuery = useQuery({
    queryKey: ['container-info', host, containerId],
    queryFn: () => getContainerInfo({ data: { containerId, host } }),
    staleTime: 60_000,
  });

  // Auto-refresh charts when the range includes "now" (within 30s)
  const includesNow = debouncedRange.to >= Date.now() - 30_000;

  // ─── Stream 2: Chart detail (debounced, fine-grained) ───
  const chartQuery = useQuery({
    queryKey: ['container-charts', host, containerId, debouncedRange.from, debouncedRange.to],
    queryFn: () => getContainerHistory({
      data: {
        containerId,
        host,
        fromMs: debouncedRange.from,
        toMs: debouncedRange.to,
        targetPoints: 600,
      },
    }),
    refetchInterval: includesNow ? 10_000 : false,
  });

  // Slider drag → debounced chart update only
  const handleRangeChange = useCallback((from: number, to: number) => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedRange({ from, to });
    }, CHART_DEBOUNCE_MS);
  }, []);

  // Preset click → immediate timeline refetch + chart range reset
  const handlePresetChange = useCallback((ms: number) => {
    setTimelineRangeMs(ms);
    const presetNow = Date.now();
    const from = presetNow - ms;
    clearTimeout(debounceRef.current);
    setDebouncedRange({ from, to: presetNow });
  }, []);

  // Cleanup debounce timer
  useEffect(() => () => clearTimeout(debounceRef.current), []);

  // Sync URL search params when debounced range or metrics change
  useEffect(() => {
    const metricsStr = Array.from(selectedMetrics).join(',');
    navigate({
      search: (prev) => ({
        ...prev,
        metrics: metricsStr,
        from: debouncedRange.from,
        to: debouncedRange.to,
      }),
      replace: true,
    });
  }, [debouncedRange, selectedMetrics, navigate]);

  const handleMetricsChange = useCallback((metrics: Set<MetricType>) => {
    setSelectedMetrics(metrics);
  }, []);

  // Container display info
  const containerName = infoQuery.data?.containerName ?? containerId.substring(0, 12);
  const containerImage = infoQuery.data?.image ?? '';
  const containerIcon = infoQuery.data?.icon ?? null;
  const iconUrl = containerImage ? getIconUrl(containerIcon, containerImage) : FALLBACK_ICON_URL;
  const [iconError, setIconError] = useState(false);

  const timelineData = useMemo(() => timelineQuery.data ?? [], [timelineQuery.data]);
  const chartData = useMemo(() => chartQuery.data ?? [], [chartQuery.data]);

  // Derive chart axis range from actual data so axis + data update atomically
  const chartFrom = chartData.length > 0 ? new Date(chartData[0].time).getTime() : debouncedRange.from;
  const chartTo = chartData.length > 0 ? new Date(chartData[chartData.length - 1].time).getTime() : debouncedRange.to;

  return (
    <div className="flex flex-col min-h-[calc(100vh-64px)]">
      {/* Header */}
      <div className="p-6 pb-4">
        <Link to="/" className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 mb-3">
          <ArrowLeft size={14} />
          Docker Dashboard
        </Link>

        <div className="flex items-center gap-3 mb-4">
          <img
            src={iconError ? FALLBACK_ICON_URL : iconUrl}
            alt=""
            className="w-8 h-8 flex-shrink-0"
            onError={() => setIconError(true)}
          />
          <div>
            <Typography level="h3">{containerName}</Typography>
            {containerImage && (
              <Typography level="body-xs" className="text-neutral-500">{containerImage}</Typography>
            )}
          </div>
          {chartQuery.isFetching && (
            <CircularProgress size="sm" variant="plain" className="ml-2" />
          )}
        </div>

        <MetricCheckboxes selected={selectedMetrics} onChange={handleMetricsChange} />
      </div>

      {/* Charts area */}
      <div className="flex-1 px-6 pb-4">
        {chartData.length === 0 && !chartQuery.isFetching ? (
          <div className="flex items-center justify-center h-64 text-neutral-500">
            <Typography level="body-md">No data available for this time range.</Typography>
          </div>
        ) : (
          <HistoricalChartsGrid
            data={chartData}
            selectedMetrics={selectedMetrics}
            from={chartFrom}
            to={chartTo}
          />
        )}
      </div>

      {/* Sticky timeline — preset-driven data, slider selects chart sub-range */}
      <HistoricalTimeline
        timelineData={timelineData}
        initialFrom={initialRange.from}
        initialTo={initialRange.to}
        onRangeChange={handleRangeChange}
        timelineRangeMs={timelineRangeMs}
        onPresetChange={handlePresetChange}
      />
    </div>
  );
}
