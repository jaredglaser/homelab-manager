import { useCallback } from 'react';
import { CircularProgress, Sheet, Typography } from '@mui/joy';
import { useTimeSeriesBuffer } from '@/hooks/useTimeSeriesBuffer';
import { getHistoricalZFSChartData } from '@/data/zfs.functions';
import ZFSPoolSpeedChart from './ZFSPoolSpeedChart';

export default function ZFSPoolSpeedCharts() {
  const fetchInitialData = useCallback(() => getHistoricalZFSChartData(), []);

  const { poolsData, isConnected, error } = useTimeSeriesBuffer({
    sseUrl: '/api/zfs-stats',
    fetchInitialData,
  });

  if (error && poolsData.size === 0) {
    return (
      <Sheet variant="outlined" className="mt-6 rounded-sm p-4">
        <Typography color="danger">
          Error connecting to ZFS stats: {error.message}
        </Typography>
      </Sheet>
    );
  }

  if (!isConnected && poolsData.size === 0) {
    return (
      <Sheet variant="outlined" className="mt-6 flex justify-center rounded-sm p-4">
        <CircularProgress />
      </Sheet>
    );
  }

  const pools = Array.from(poolsData.values());

  if (pools.length === 0) {
    return null;
  }

  return (
    <Sheet variant="outlined" className="mt-6 rounded-sm p-4">
      <Typography level="title-md" className="mb-3">
        Pool I/O Speed
      </Typography>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {pools.map((pool) => (
          <ZFSPoolSpeedChart
            key={pool.poolName}
            poolName={pool.poolName}
            dataPoints={pool.dataPoints}
          />
        ))}
      </div>
    </Sheet>
  );
}
