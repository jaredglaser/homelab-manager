import { Sheet, CircularProgress, Box } from '@mui/joy';
import { useContainerChartData } from '@/hooks/useContainerChartData';
import { formatAsPercent, formatBytes, formatBitsSIUnits } from '@/formatters/metrics';
import ContainerMetricChart from './ContainerMetricChart';
import type { DockerStatsFromDB } from '@/types/docker';

interface ContainerChartsCardProps {
  containerId: string;
  containerStats: DockerStatsFromDB;
}

export default function ContainerChartsCard({
  containerId,
  containerStats,
}: ContainerChartsCardProps) {
  const { dataPoints, isLoading } = useContainerChartData({
    containerId,
    currentStats: containerStats.rates,
  });

  if (isLoading) {
    return (
      <Sheet variant="outlined" className="m-2 p-4 rounded-sm">
        <Box className="flex items-center justify-center h-32">
          <CircularProgress size="sm" />
        </Box>
      </Sheet>
    );
  }

  // Transform data points for each chart
  const cpuData = dataPoints.map((d) => ({ timestamp: d.timestamp, value: d.cpuPercent }));
  const memoryData = dataPoints.map((d) => ({ timestamp: d.timestamp, value: d.memoryPercent }));
  const blockReadData = dataPoints.map((d) => ({ timestamp: d.timestamp, value: d.blockIoReadBytesPerSec }));
  const blockWriteData = dataPoints.map((d) => ({ timestamp: d.timestamp, value: d.blockIoWriteBytesPerSec }));
  const networkRxData = dataPoints.map((d) => ({ timestamp: d.timestamp, value: d.networkRxBytesPerSec }));
  const networkTxData = dataPoints.map((d) => ({ timestamp: d.timestamp, value: d.networkTxBytesPerSec }));

  return (
    <Sheet variant="outlined" className="m-2 p-4 rounded-sm">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <ContainerMetricChart
          title="CPU %"
          dataPoints={cpuData}
          colorVar="--chart-cpu"
          formatValue={(v) => formatAsPercent(v / 100)}
        />
        <ContainerMetricChart
          title="Memory %"
          dataPoints={memoryData}
          colorVar="--chart-memory"
          formatValue={(v) => formatAsPercent(v / 100)}
        />
        <ContainerMetricChart
          title="Block Read"
          dataPoints={blockReadData}
          colorVar="--chart-read"
          formatValue={(v) => formatBytes(v, true)}
        />
        <ContainerMetricChart
          title="Block Write"
          dataPoints={blockWriteData}
          colorVar="--chart-write"
          formatValue={(v) => formatBytes(v, true)}
        />
        <ContainerMetricChart
          title="Network RX"
          dataPoints={networkRxData}
          colorVar="--chart-read"
          formatValue={(v) => formatBitsSIUnits(v * 8, true)}
        />
        <ContainerMetricChart
          title="Network TX"
          dataPoints={networkTxData}
          colorVar="--chart-write"
          formatValue={(v) => formatBitsSIUnits(v * 8, true)}
        />
      </div>
    </Sheet>
  );
}
