import { useMemo } from 'react';
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
        timestamp: row.time,
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
    <div className="mt-6 rounded-sm p-4 bg-card border border-border">
      <p className="text-base mb-3">
        Pool I/O Speed
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {pools.map((pool) => (
          <ZFSPoolSpeedChart
            key={pool.poolName}
            poolName={pool.poolName}
            dataPoints={pool.dataPoints}
          />
        ))}
      </div>
    </div>
  );
}
