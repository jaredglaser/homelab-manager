import { memo, useEffect, useState } from 'react';
import { Paper, Skeleton, Typography } from '@mui/material';
import { useXtermSetup } from '@/hooks/useXtermSetup';
import { useContainerLogs } from '@/hooks/useContainerLogs';

interface ContainerLogViewerProps {
  containerId: string;
  host: string;
}

export default memo(function ContainerLogViewer({
  containerId,
  host,
}: ContainerLogViewerProps) {
  const { containerRef, terminal, error: setupError } = useXtermSetup({ disableStdin: true, convertEol: true });
  const [ready, setReady] = useState(false);

  const { isConnected, error: logsError } = useContainerLogs({
    containerId,
    host,
    terminal,
  });

  // Surface either failure path: xterm bootstrap (dynamic import) or logs stream.
  const error = setupError ?? logsError;

  // Mark ready once connected so xterm has painted its first content
  useEffect(() => {
    if (isConnected && terminal) setReady(true);
  }, [isConnected, terminal]);

  const showSkeleton = !ready && !error;

  return (
    <Paper
      elevation={0}
      className="relative rounded-sm bg-(--mui-palette-background-chartBg)! h-full min-h-0 flex flex-col overflow-hidden"
    >
      <div
        ref={containerRef}
        className={`flex-1 p-2 min-h-0 transition-opacity duration-300 ${showSkeleton ? 'opacity-0' : 'opacity-100'}`}
      />
      {showSkeleton && (
        <div className="absolute inset-0 top-10 px-3 pb-3 flex flex-col gap-1">
          {Array.from({ length: 14 }, (_, i) => (
            <Skeleton
              key={i}
              variant="text"
              width={`${45 + ((i * 37) % 50)}%`}
              className="bg-(--mui-palette-action-hover)! text-xs!"
            />
          ))}
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-sm">
          <Typography variant="body2" color="error">
            {error.message}
          </Typography>
        </div>
      )}
    </Paper>
  );
});
