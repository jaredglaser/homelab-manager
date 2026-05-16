import { Typography } from '@mui/material';
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
}

export default function ContainerHistoryPage({
  containerId,
  host,
  initialMetrics,
  initialFrom,
  initialTo,
}: Readonly<ContainerHistoryPageProps>) {
  const {
    isChartDataEmpty,
    timelineData,
    chartData,
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
      <div className="sticky top-0 z-10 bg-(--mui-palette-background-level1)! border-b border-(--mui-palette-divider) px-6 py-3 select-none">
        <MetricCheckboxes selected={selectedMetrics} onChange={handleMetricsChange} />
      </div>

      <div className="overflow-y-auto flex-1 min-h-0 themed-scrollbar">
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
