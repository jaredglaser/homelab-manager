import { Typography, CircularProgress, IconButton, Skeleton } from '@mui/material';
import { X } from 'lucide-react';
import { FALLBACK_ICON_URL } from '@/lib/utils/icon-resolver';
import MetricCheckboxes from '@/components/docker/MetricCheckboxes';
import HistoricalChartsGrid from '@/components/docker/HistoricalChartsGrid';
import HistoricalTimeline from '@/components/docker/HistoricalTimeline';
import { useContainerHistoryData } from '@/components/docker/useContainerHistoryData';

interface ContainerHistoryPageProps {
  containerId: string;
  host?: string;
  initialMetrics: string;
  initialFrom?: number;
  initialTo?: number;
  onClose?: () => void;
}

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
  const {
    isInfoLoading,
    isChartFetching,
    isChartDataEmpty,
    timelineData,
    chartData,
    containerName,
    containerImage,
    iconUrl,
    iconError,
    showServiceKey,
    serviceKey,
    setIconError,
    initialRange,
    timelineRange,
    activePresetMs,
    chartFrom,
    chartTo,
    selectedMetrics,
    handleMetricsChange,
    handleRangeChange,
    handlePresetChange,
    handleCustomRangeChange,
  } = useContainerHistoryData({ containerId, host, initialMetrics, initialFrom, initialTo });

  return (
    <div className="flex flex-col min-h-0">
      {/* Sticky panel header */}
      <div className="sticky top-0 z-10 bg-(--mui-palette-background-level1)! border-b border-(--mui-palette-divider) px-6 pt-4 pb-3 select-none">
        <div className="relative">
          {/* Real content: always in flow, determines height */}
          <div className={`flex items-center gap-3 transition-opacity duration-300 ${isInfoLoading ? 'opacity-0' : 'opacity-100'}`}>
            <img
              src={iconError ? FALLBACK_ICON_URL : iconUrl}
              alt=""
              className="w-8 h-8 shrink-0"
              onError={() => setIconError(true)}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Typography variant="h5" noWrap>{containerName}</Typography>
                {isChartFetching && (
                  <CircularProgress size={18} />
                )}
              </div>
              {showServiceKey && (
                <Typography variant="caption" className="text-(--mui-palette-text-secondary) block" noWrap>Service: {serviceKey}</Typography>
              )}
              <Typography variant="caption" className="text-(--mui-palette-text-secondary) block" noWrap>{containerImage || ' '}</Typography>
            </div>
            {onClose && (
              <IconButton onClick={onClose} aria-label="Close history panel" className="shrink-0!">
                <X size={20} />
              </IconButton>
            )}
          </div>
          {/* Skeleton overlay: always absolute, fades out */}
          <div className={`absolute inset-0 flex items-center gap-3 transition-opacity duration-300 ${isInfoLoading ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
            <Skeleton variant="rounded" width={32} height={32} className="shrink-0" />
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
          {isChartDataEmpty ? (
            <div className="flex items-center justify-center h-64 text-(--mui-palette-text-secondary)">
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
