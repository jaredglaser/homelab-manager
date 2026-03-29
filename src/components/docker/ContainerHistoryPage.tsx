import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Typography, CircularProgress, IconButton, Skeleton } from '@mui/material';
import { X } from 'lucide-react';
import { getContainerHistory, getContainerInfo } from '@/data/docker/functions';
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
  onClose?: () => void;
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
 * Render a container's historical metrics UI including a timeline, selectable metrics, and detailed charts.
 *
 * Synchronizes selected metrics and visible range to the URL, debounces chart-range updates, and auto-refreshes data when the requested range includes the current time.
 *
 * @param containerId - ID of the container to display
 * @param host - Optional host identifier used for data requests
 * @param initialMetrics - Comma-separated metrics string used to initialize selected metrics
 * @param initialFrom - Optional initial start time in milliseconds since epoch for the visible range
 * @param initialTo - Optional initial end time in milliseconds since epoch for the visible range
 * @returns The rendered ContainerHistoryPage element
 */
export default function ContainerHistoryPage({
  containerId,
  host,
  initialMetrics,
  initialFrom,
  initialTo,
  onClose,
}: Readonly<ContainerHistoryPageProps>) {

  const now = useRef(Date.now()).current;
  const initialRange = useRef({
    from: initialFrom ?? now - DEFAULT_RANGE_MS,
    to: initialTo ?? now,
  }).current;

  // Absolute timeline range - determines what data the timeline fetches.
  // Presets compute { from: now - ms, to: now }; custom dates set arbitrary values.
  const [timelineRange, setTimelineRange] = useState(initialRange);

  // Track which preset is active (null = custom range)
  const [activePresetMs, setActivePresetMs] = useState<number | null>(() => {
    const span = initialRange.to - initialRange.from;
    const PRESETS = [3_600_000, 21_600_000, 43_200_000, 86_400_000, 259_200_000, 604_800_000, 2_592_000_000];
    return PRESETS.find((p) => Math.abs(span - p) / p < 0.05) ?? null;
  });

  // Debounced range drives chart query - updated after 800ms of slider idle
  const [debouncedRange, setDebouncedRange] = useState(initialRange);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Metric selection state
  const [selectedMetrics, setSelectedMetrics] = useState<Set<MetricType>>(
    () => parseMetrics(initialMetrics),
  );

  // ─── Stream 1: Timeline data for the current range ───
  // Query key includes absolute from/to so presets and custom ranges trigger refetch.
  // Auto-refresh only when the range actually overlaps the current moment.
  const currentTime = Date.now();
  const timelineIncludesNow = timelineRange.from <= currentTime && timelineRange.to >= currentTime - 30_000;
  const timelineQuery = useQuery({
    queryKey: ['container-timeline', host, containerId, timelineRange.from, timelineRange.to],
    queryFn: () => getContainerHistory({
      data: {
        containerId,
        host,
        fromMs: timelineRange.from,
        toMs: timelineRange.to,
        targetPoints: 2000,
      },
    }),
    staleTime: 30_000,
    refetchInterval: timelineIncludesNow ? 60_000 : false,
  });

  // Fetch container info (name, image, icon)
  const infoQuery = useQuery({
    queryKey: ['container-info', host, containerId],
    queryFn: () => getContainerInfo({ data: { containerId, host } }),
    staleTime: 60_000,
  });

  // Auto-refresh charts when the range actually overlaps "now" (within 30s)
  const includesNow = debouncedRange.from <= currentTime && debouncedRange.to >= currentTime - 30_000;

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
    const presetNow = Date.now();
    const from = presetNow - ms;
    setTimelineRange({ from, to: presetNow });
    setActivePresetMs(ms);
    clearTimeout(debounceRef.current);
    setDebouncedRange({ from, to: presetNow });
  }, []);

  // Custom date range → timeline + chart range update, deselect preset
  const handleCustomRangeChange = useCallback((from: number, to: number) => {
    setTimelineRange({ from, to });
    setActivePresetMs(null);
    clearTimeout(debounceRef.current);
    setDebouncedRange({ from, to });
  }, []);

  // Cleanup debounce timer
  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const handleMetricsChange = useCallback((metrics: Set<MetricType>) => {
    setSelectedMetrics(metrics);
  }, []);

  // Container display info
  const containerName = infoQuery.data?.containerName ?? containerId.substring(0, 12);
  const containerImage = infoQuery.data?.image ?? '';
  const containerIcon = infoQuery.data?.icon ?? null;
  const serviceKey = infoQuery.data?.serviceKey ?? null;
  // Only show service key label when it's compose-based (contains '/'), i.e. "media-stack/plex".
  // When it's just the container name fallback, the label would be redundant.
  const showServiceKey = serviceKey?.includes('/') ?? false;
  const iconUrl = containerImage ? getIconUrl(containerIcon, containerImage) : FALLBACK_ICON_URL;
  const [iconError, setIconError] = useState(false);

  // Reset icon error when the resolved URL changes (e.g. new valid icon assigned)
  useEffect(() => {
    setIconError(false);
  }, [iconUrl]);

  const timelineData = useMemo(() => timelineQuery.data ?? [], [timelineQuery.data]);
  const chartData = useMemo(() => chartQuery.data ?? [], [chartQuery.data]);

  // Always use the requested range for chart axes - this keeps the full time range
  // visible even when data only covers a portion, preventing the appearance of
  // low-resolution data when the range exceeds available history.
  const chartFrom = debouncedRange.from;
  const chartTo = debouncedRange.to;

  return (
    <div className="flex flex-col min-h-0">
      {/* Sticky panel header */}
      <div className="sticky top-0 z-10 !bg-[var(--mui-palette-background-level1)] border-b border-[var(--mui-palette-divider)] px-6 pt-4 pb-3 select-none">
        <div className="relative">
          {/* Real content — always in flow, determines height */}
          <div className={`flex items-center gap-3 transition-opacity duration-300 ${infoQuery.isLoading ? 'opacity-0' : 'opacity-100'}`}>
            <img
              src={iconError ? FALLBACK_ICON_URL : iconUrl}
              alt=""
              className="w-8 h-8 flex-shrink-0"
              onError={() => setIconError(true)}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Typography variant="h5" noWrap>{containerName}</Typography>
                {chartQuery.isFetching && (
                  <CircularProgress size={18} />
                )}
              </div>
              {showServiceKey && (
                <Typography variant="caption" className="text-[var(--mui-palette-text-secondary)] block" noWrap>Service: {serviceKey}</Typography>
              )}
              <Typography variant="caption" className="text-neutral-500 block" noWrap>{containerImage || '\u00A0'}</Typography>
            </div>
            {onClose && (
              <IconButton onClick={onClose} aria-label="Close history panel" className="!flex-shrink-0">
                <X size={20} />
              </IconButton>
            )}
          </div>
          {/* Skeleton overlay — always absolute, fades out */}
          <div className={`absolute inset-0 flex items-center gap-3 transition-opacity duration-300 ${infoQuery.isLoading ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
            <Skeleton variant="rounded" width={32} height={32} className="flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <Typography variant="h5"><Skeleton width={180} /></Typography>
              <Typography variant="caption"><Skeleton width={120} /></Typography>
            </div>
          </div>
        </div>
        <div className="mt-3">
          <MetricCheckboxes selected={selectedMetrics} onChange={handleMetricsChange} />
        </div>
      </div>

      {/* Scrollable content */}
      <div className="overflow-y-auto flex-1 min-h-0 themed-scrollbar">
        {/* Charts area */}
        <div className="px-6 py-4">
          {chartData.length === 0 && !chartQuery.isFetching ? (
            <div className="flex items-center justify-center h-64 text-neutral-500">
              <Typography variant="body1">No data available for this time range.</Typography>
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

        {/* Sticky timeline - preset/custom range data, slider selects chart sub-range */}
        <HistoricalTimeline
          timelineData={timelineData}
          initialFrom={initialRange.from}
          initialTo={initialRange.to}
          onRangeChange={handleRangeChange}
          timelineFrom={timelineRange.from}
          timelineTo={timelineRange.to}
          activePresetMs={activePresetMs}
          onPresetChange={handlePresetChange}
          onCustomRangeChange={handleCustomRangeChange}
        />
      </div>
    </div>
  );
}
