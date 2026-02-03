import Table from '@mui/joy/Table';
import { Box, CircularProgress, Typography } from '@mui/joy';
import ContainerRow from './ContainerRow';
import { streamAllDockerContainerStats } from '@/data/docker.functions';
import { useEffect, useState } from 'react';
import type { ContainerStatsWithRates } from '@/types/docker';

export default function ContainerTable() {
  const [stats, setStats] = useState<Map<string, ContainerStatsWithRates>>(new Map());
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let aborted = false;

    async function startStream() {
      console.log('[ContainerTable] Starting stream');
      setIsStreaming(true);
      setError(null);

      try {
        let statsReceived = 0;
        for await (const stat of await streamAllDockerContainerStats()) {
          if (aborted) {
            console.log('[ContainerTable] Stream aborted by component unmount');
            break;
          }

          statsReceived++;
          console.log(`[ContainerTable] Received stat #${statsReceived} for container ${stat.name}`);

          setStats(prevStats => {
            const newStats = new Map(prevStats);
            newStats.set(stat.id, stat);
            console.log(`[ContainerTable] Updated stats map, now tracking ${newStats.size} containers`);
            return newStats;
          });
        }
        console.log('[ContainerTable] Stream completed normally');
      } catch (err) {
        if (!aborted) {
          console.error('[ContainerTable] Stream error:', err);
          setError(err as Error);
        }
      } finally {
        if (!aborted) {
          console.log('[ContainerTable] Stream ended, setting isStreaming to false');
          setIsStreaming(false);
        }
      }
    }

    startStream();

    return () => {
      console.log('[ContainerTable] Component unmounting, aborting stream');
      aborted = true; // Cleanup on unmount
    };
  }, []);

  if (error) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography color="danger">
          Error streaming Docker stats: {error.message}
        </Typography>
      </Box>
    );
  }

  if (!isStreaming && stats.size === 0) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Table aria-label="docker containers table" sx={{ '& thead th': { fontWeight: 600 } }}>
      <thead>
        <tr>
          <th className="w-[20%]">Container Name</th>
          <th className="text-right">CPU %</th>
          <th className="text-right">RAM %</th>
          <th className="text-right">Block Read (MB/s)</th>
          <th className="text-right">Block Write (MB/s)</th>
          <th className="text-right">Network RX (Mbps)</th>
          <th className="text-right">Network TX (Mbps)</th>
        </tr>
      </thead>
      <tbody>
        {Array.from(stats.values()).map((containerStat) => (
          <ContainerRow key={containerStat.id} container={containerStat} />
        ))}
      </tbody>
    </Table>
  );
}
