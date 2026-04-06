import { memo, useMemo } from 'react';
import { Divider } from '@mui/material';
import { formatAsPercent, formatBitsSIUnits } from '@/formatters/metrics';
import DualSeriesChart from '@/components/docker/DualSeriesChart';
import ContainerLogViewer from '@/components/docker/ContainerLogViewer';
import type { ChartDataPoint } from '@/hooks/useContainerChartData';

interface ContainerDetailPanelProps {
  dataPoints: ChartDataPoint[];
  containerId: string;
  host: string;
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

  return (
    <div className="bg-[var(--mui-palette-action-hover)] pb-4 border-b border-[var(--mui-palette-divider)]">
      <Divider />
      <div className="grid lg:grid-cols-2 gap-4 px-4 pt-4">
        <div className="flex flex-col gap-3">
          <DualSeriesChart
            title="CPU & Memory"
            series={cpuMemSeries}
            yAxisMode="percent"
            formatValue={formatPercent}
          />
          <DualSeriesChart
            title="Network I/O"
            series={networkSeries}
            yAxisMode="bits"
            formatValue={formatNetwork}
          />
        </div>
        <div className="h-[300px] lg:h-full">
          <ContainerLogViewer containerId={containerId} host={host} />
        </div>
      </div>
    </div>
  );
});
