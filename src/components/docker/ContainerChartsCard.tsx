import { memo, useMemo } from 'react';
import { Paper } from '@mui/material';
import { formatAsPercent, formatBitsSIUnits } from '@/formatters/metrics';
import DualSeriesChart from './DualSeriesChart';
import ContainerLogViewer from './ContainerLogViewer';

interface ContainerChartDataPoint {
  timestamp: number;
  cpuPercent: number;
  memoryPercent: number;
  blockIoReadBytesPerSec: number;
  blockIoWriteBytesPerSec: number;
  networkRxBytesPerSec: number;
  networkTxBytesPerSec: number;
}

interface ContainerChartsCardProps {
  dataPoints: ContainerChartDataPoint[];
  containerId: string;
  host: string;
}

// Stable formatter references to avoid breaking DualSeriesChart memo
const formatPercent = (v: number) => formatAsPercent(v / 100);
const formatNetwork = (v: number) => formatBitsSIUnits(v * 8, true);

interface SeriesConfig {
  name: string;
  dataPoints: { timestamp: number; value: number }[];
  colorVar: string;
}

type DualSeries = [SeriesConfig, SeriesConfig];

export default memo(function ContainerChartsCard({
  dataPoints,
  containerId,
  host,
}: ContainerChartsCardProps) {
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
        dataPoints: dataPoints.map((d) => ({ timestamp: d.timestamp, value: d.networkRxBytesPerSec })),
        colorVar: '--chart-read',
      },
      {
        name: 'TX',
        dataPoints: dataPoints.map((d) => ({ timestamp: d.timestamp, value: d.networkTxBytesPerSec })),
        colorVar: '--chart-write',
      },
    ],
    [dataPoints],
  );

  return (
    <Paper variant="outlined" className="m-2 p-4 rounded-sm">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
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
            yAxisMode="bytes"
            formatValue={formatNetwork}
          />
        </div>
        <ContainerLogViewer containerId={containerId} host={host} />
      </div>
    </Paper>
  );
});
