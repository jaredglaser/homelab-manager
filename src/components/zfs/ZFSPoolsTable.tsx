import { useEffect, useState } from 'react';
import Table from '@mui/joy/Table';
import { Box, CircularProgress, Typography } from '@mui/joy';
import { streamZFSIOStat } from '@/data/zfs.functions';
import type { ZFSHierarchy } from '@/types/zfs';
import { buildHierarchy } from '@/lib/utils/zfs-hierarchy-builder';
import ZFSPoolAccordion from './ZFSPoolAccordion';

export default function ZFSPoolsTable() {
  const [poolStats, setPoolStats] = useState<ZFSHierarchy>(new Map());
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let aborted = false;

    async function startStream() {
      setIsStreaming(true);
      setError(null);

      try {
        // The server now yields a complete ZFSIOStatWithRates[] per cycle,
        // so each iteration gives us a full snapshot of all pools/vdevs/disks.
        for await (const cycleStats of await streamZFSIOStat()) {
          if (aborted) break;

          const hierarchy = buildHierarchy(cycleStats);
          setPoolStats(hierarchy);
        }
      } catch (err) {
        if (!aborted) {
          console.error('[ZFSPoolsTable] Stream error:', err);
          setError(err as Error);
        }
      } finally {
        if (!aborted) {
          setIsStreaming(false);
        }
      }
    }

    startStream();

    return () => {
      aborted = true;
    };
  }, []);

  if (error) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography color="danger">
          Error streaming ZFS stats: {error.message}
        </Typography>
      </Box>
    );
  }

  if (!isStreaming && poolStats.size === 0) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Table aria-label="zfs pools table" sx={{ '& thead th': { fontWeight: 600 } }}>
      <thead>
        <tr>
          <th style={{ width: '30%' }}>Pool / Device</th>
          <th style={{ textAlign: 'right' }}>Capacity</th>
          <th style={{ textAlign: 'right' }}>Read Ops/s</th>
          <th style={{ textAlign: 'right' }}>Write Ops/s</th>
          <th style={{ textAlign: 'right' }}>Read</th>
          <th style={{ textAlign: 'right' }}>Write</th>
          <th style={{ textAlign: 'right' }}>Utilization</th>
        </tr>
      </thead>
      <tbody>
        {Array.from(poolStats.values()).map((pool) => (
          <ZFSPoolAccordion key={pool.data.id} pool={pool} />
        ))}
      </tbody>
    </Table>
  );
}
