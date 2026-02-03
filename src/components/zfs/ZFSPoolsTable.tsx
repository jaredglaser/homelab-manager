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

      let retryCount = 0;
      const maxRetryDelay = 30_000;
      const baseDelay = 1_000;

      while (!aborted) {
        try {
          for await (const cycleStats of await streamZFSIOStat()) {
            if (aborted) break;
            retryCount = 0; // Reset backoff on successful data
            setError(null);
            const hierarchy = buildHierarchy(cycleStats);
            setPoolStats(hierarchy);
          }

          if (!aborted) {
            console.log('[ZFSPoolsTable] Stream ended, will reconnect');
          }
        } catch (err) {
          if (!aborted) {
            console.error('[ZFSPoolsTable] Stream error:', err);
            setError(err as Error);
          }
        }

        if (aborted) break;

        const delay = Math.min(baseDelay * 2 ** retryCount, maxRetryDelay);
        retryCount++;
        console.log(`[ZFSPoolsTable] Reconnecting in ${delay}ms (attempt ${retryCount})`);
        await new Promise((r) => setTimeout(r, delay));
        setError(null);
      }

      setIsStreaming(false);
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
    <Table aria-label="zfs pools table" sx={{
      tableLayout: 'fixed',
      '& thead th': { fontWeight: 600 },
      '& td:first-child': { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    }}>
      <thead>
        <tr>
          <th style={{ width: '30%' }}>Pool / Device</th>
          <th style={{ width: '14%', textAlign: 'right' }}>Capacity</th>
          <th style={{ width: '11%', textAlign: 'right' }}>Read Ops/s</th>
          <th style={{ width: '11%', textAlign: 'right' }}>Write Ops/s</th>
          <th style={{ width: '11%', textAlign: 'right' }}>Read</th>
          <th style={{ width: '11%', textAlign: 'right' }}>Write</th>
          <th style={{ width: '12%', textAlign: 'right' }}>Utilization</th>
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
