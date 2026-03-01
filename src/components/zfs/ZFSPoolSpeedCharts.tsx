import { useMemo } from 'react';
import { Paper, Typography } from '@mui/material';
import type { ZFSStatsRow } from '@/types/zfs';
import ZFSPoolSpeedChart from './ZFSPoolSpeedChart';

interface TimeSeriesDataPoint {
  timestamp: number;
  readBytesPerSec: number;
  writeBytesPerSec: number;
}

interface PoolTimeSeriesData {
  poolName: string;
  dataPoints: TimeSeriesDataPoint[];
}

interface ZFSPoolSpeedChartsProps {
  rows: ZFSStatsRow[];
}

/**
 * Render speed charts for ZFS pools derived from the provided stats rows.
 *
 * Builds time-series data per pool (grouped by host/pool when multiple hosts are present)
 * and renders a ZFSPoolSpeedChart for each pool. Returns `null` when no pool-level data exists.
 *
 * @param rows - Array of ZFSStatsRow records used to construct pool time-series data
 * @returns A React element containing one chart per pool, or `null` if there are no pools
 */
export default function ZFSPoolSpeedCharts({ rows }: ZFSPoolSpeedChartsProps) {
  const pools = useMemo<PoolTimeSeriesData[]>(() => {
    // Filter to pool-level entities only (no '/' in entity path)
    const poolRows = rows.filter((r) => !r.entity.includes('/'));

    // Check if there are multiple hosts
    const hosts = new Set(poolRows.map(r => r.host));
    const multiHost = hosts.size > 1;

    // Group by host/pool (or just pool for single host)
    const poolMap = new Map<string, TimeSeriesDataPoint[]>();
    for (const row of poolRows) {
      const key = multiHost && row.host ? `${row.host}/${row.pool}` : row.pool;
      let points = poolMap.get(key);
      if (!points) {
        points = [];
        poolMap.set(key, points);
      }
      points.push({
        timestamp: new Date(row.time).getTime(),
        readBytesPerSec: row.read_bytes_per_sec ?? 0,
        writeBytesPerSec: row.write_bytes_per_sec ?? 0,
      });
    }

    const result: PoolTimeSeriesData[] = [];
    for (const [poolName, dataPoints] of poolMap) {
      result.push({ poolName, dataPoints });
    }
    result.sort((a, b) => a.poolName.localeCompare(b.poolName));
    return result;
  }, [rows]);

  if (pools.length === 0) {
    return null;
  }

  return (
    <Paper variant="outlined" className="mt-6 rounded-sm p-4">
      <Typography variant="subtitle1" className="mb-3">
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
    </Paper>
  );
}
