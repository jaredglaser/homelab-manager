import { memo, useMemo } from 'react';
import { Sheet } from '@mui/joy';
import { formatAsPercent, formatBytes, formatBitsSIUnits } from '@/formatters/metrics';
import ContainerMetricChart from './ContainerMetricChart';

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
}

// Stable formatter references to avoid breaking ContainerMetricChart memo
const formatCpu = (v: number) => formatAsPercent(v / 100);
const formatMemory = (v: number) => formatAsPercent(v / 100);
const formatBlockRead = (v: number) => formatBytes(v, true);
const formatBlockWrite = (v: number) => formatBytes(v, true);
const formatNetworkRx = (v: number) => formatBitsSIUnits(v * 8, true);
const formatNetworkTx = (v: number) => formatBitsSIUnits(v * 8, true);

export default memo(function ContainerChartsCard({
  dataPoints,
}: ContainerChartsCardProps) {
  // Memoize transformed data arrays
  const chartData = useMemo(() => ({
    cpu: dataPoints.map((d) => ({ timestamp: d.timestamp, value: d.cpuPercent })),
    memory: dataPoints.map((d) => ({ timestamp: d.timestamp, value: d.memoryPercent })),
    blockRead: dataPoints.map((d) => ({ timestamp: d.timestamp, value: d.blockIoReadBytesPerSec })),
    blockWrite: dataPoints.map((d) => ({ timestamp: d.timestamp, value: d.blockIoWriteBytesPerSec })),
    networkRx: dataPoints.map((d) => ({ timestamp: d.timestamp, value: d.networkRxBytesPerSec })),
    networkTx: dataPoints.map((d) => ({ timestamp: d.timestamp, value: d.networkTxBytesPerSec })),
  }), [dataPoints]);

  return (
    <Sheet variant="outlined" className="m-2 p-4 rounded-sm">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <ContainerMetricChart
          title="CPU %"
          dataPoints={chartData.cpu}
          colorVar="--chart-cpu"
          formatValue={formatCpu}
        />
        <ContainerMetricChart
          title="Memory %"
          dataPoints={chartData.memory}
          colorVar="--chart-memory"
          formatValue={formatMemory}
        />
        <ContainerMetricChart
          title="Block Read"
          dataPoints={chartData.blockRead}
          colorVar="--chart-read"
          formatValue={formatBlockRead}
        />
        <ContainerMetricChart
          title="Block Write"
          dataPoints={chartData.blockWrite}
          colorVar="--chart-write"
          formatValue={formatBlockWrite}
        />
        <ContainerMetricChart
          title="Network RX"
          dataPoints={chartData.networkRx}
          colorVar="--chart-read"
          formatValue={formatNetworkRx}
        />
        <ContainerMetricChart
          title="Network TX"
          dataPoints={chartData.networkTx}
          colorVar="--chart-write"
          formatValue={formatNetworkTx}
        />
      </div>
    </Sheet>
  );
});
