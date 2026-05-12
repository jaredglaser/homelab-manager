import { memo, useMemo } from 'react';
import { Divider } from '@mui/material';
import { formatAsPercent, formatBitsSIUnits } from '@/formatters/metrics';
import DualSeriesChart from '@/components/docker/DualSeriesChart';
import ContainerLogViewer from '@/components/docker/ContainerLogViewer';
import type { ChartDataPoint } from '@/hooks/useContainerChartData';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';

interface ContainerDetailPanelProps {
  dataPoints: ChartDataPoint[];
  containerId: string;
  host: string;
  inventory: DockerInventorySnapshotContainer;
}

const formatPercent = (v: number) => formatAsPercent(v / 100);
const formatNetwork = (v: number) => formatBitsSIUnits(v, true);

interface SeriesConfig {
  name: string;
  dataPoints: { timestamp: number; value: number }[];
  colorVar: string;
}

type DualSeries = [SeriesConfig, SeriesConfig];

export default memo(function ContainerDetailPanel({
  dataPoints,
  containerId,
  host,
  inventory,
}: ContainerDetailPanelProps) {
  const cpuMemSeries = useMemo<DualSeries>(
    () => [
      {
        name: 'CPU',
        dataPoints: dataPoints.map((d) => ({ timestamp: d.timestamp, value: d.cpuPercent })),
        colorVar: '--chart-cpu',
      },
      {
        name: 'Memory',
        dataPoints: dataPoints.map((d) => ({ timestamp: d.timestamp, value: d.memoryPercent })),
        colorVar: '--chart-memory',
      },
    ],
    [dataPoints],
  );

  const networkSeries = useMemo<DualSeries>(
    () => [
      {
        name: 'RX',
        dataPoints: dataPoints.map((d) => ({ timestamp: d.timestamp, value: d.networkRxBytesPerSec * 8 })),
        colorVar: '--chart-read',
      },
      {
        name: 'TX',
        dataPoints: dataPoints.map((d) => ({ timestamp: d.timestamp, value: d.networkTxBytesPerSec * 8 })),
        colorVar: '--chart-write',
      },
    ],
    [dataPoints],
  );

  const formattedStartedAt = inventory.startedAt?.toLocaleString() ?? 'Unknown';
  const formattedFinishedAt = inventory.finishedAt?.toLocaleString() ?? null;
  const stateLabel = inventory.state.charAt(0).toUpperCase() + inventory.state.slice(1);

  return (
    <div className="bg-(--mui-palette-action-hover) pb-4 border-b border-(--mui-palette-divider)">
      <Divider />
      <div className="px-4 pt-4">
        <div className="rounded-sm border border-(--mui-palette-divider) bg-(--mui-palette-background-paper) px-3 py-2">
          <div className="text-sm font-medium">Container Status</div>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-sm text-(--mui-palette-text-secondary)">
            <div>
              <span className="font-medium text-(--mui-palette-text-primary)">State</span>
              {': '}
              <span>{stateLabel}</span>
            </div>
            <div>
              <span className="font-medium text-(--mui-palette-text-primary)">Started</span>
              {': '}
              <span>{formattedStartedAt}</span>
            </div>
            {formattedFinishedAt && (
              <div>
                <span className="font-medium text-(--mui-palette-text-primary)">Finished</span>
                {': '}
                <span>{formattedFinishedAt}</span>
              </div>
            )}
            {inventory.exitCode !== null && (
              <div>
                <span className="font-medium text-(--mui-palette-text-primary)">Exit code</span>
                {': '}
                <span>{inventory.exitCode}</span>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 grid-rows-[10rem_10rem_18rem] lg:grid-cols-2 lg:grid-rows-2 lg:h-[500px] gap-4 px-4 pt-4">
        <div className="min-h-0">
          <DualSeriesChart
            title="CPU & Memory"
            series={cpuMemSeries}
            yAxisMode="percent"
            formatValue={formatPercent}
          />
        </div>
        <div className="min-h-0">
          <DualSeriesChart
            title="Network I/O"
            series={networkSeries}
            yAxisMode="bits"
            formatValue={formatNetwork}
          />
        </div>
        <div className="min-h-0 lg:col-start-2 lg:row-start-1 lg:row-span-2">
          <ContainerLogViewer containerId={containerId} host={host} />
        </div>
      </div>
    </div>
  );
});
