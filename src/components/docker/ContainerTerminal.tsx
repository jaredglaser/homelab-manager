import { memo, useEffect, useState } from 'react';
import { Button, Paper, Skeleton, Typography } from '@mui/material';
import { useXtermSetup } from '@/hooks/useXtermSetup';
import { useContainerTerminal } from '@/hooks/useContainerTerminal';

interface ContainerTerminalProps {
  containerId: string;
  host: string;
  shell: string;
  frozen: boolean;
  /** Called when the agent reports which shell it actually spawned (for `auto`). */
  onShellResolved?: (shell: string) => void;
}

export default memo(function ContainerTerminal({
  containerId,
  host,
  shell,
  frozen,
  onShellResolved,
}: ContainerTerminalProps) {
  const { containerRef, terminal } = useXtermSetup({
    disableStdin: false,
    cursorBlink: true,
    convertEol: true,
  });
  const [ready, setReady] = useState(false);

  const { isConnected, error, resolvedShell, sessionEnded, reconnect } = useContainerTerminal({
    containerId,
    host,
    shell,
    terminal,
    enabled: !frozen,
  });

  useEffect(() => {
    if (resolvedShell && onShellResolved) onShellResolved(resolvedShell);
  }, [resolvedShell, onShellResolved]);

  // Mark ready once connected so xterm has painted its first content
  useEffect(() => {
    if (isConnected && terminal) setReady(true);
  }, [isConnected, terminal]);

  // Disable stdin when frozen so keystrokes don't queue up while container is stopped
  useEffect(() => {
    if (!terminal) return;
    terminal.options.disableStdin = frozen;
  }, [terminal, frozen]);

  const showSkeleton = !ready && !error && !frozen;

  return (
    <Paper
      elevation={0}
      className="relative rounded-sm !bg-[var(--mui-palette-background-chartBg)] h-full min-h-0 flex flex-col overflow-hidden"
    >
      <div
        ref={containerRef}
        className={`flex-1 px-2 pb-2 min-h-0 transition-opacity duration-300 ${showSkeleton ? 'opacity-0' : 'opacity-100'}`}
      />
      {showSkeleton && (
        <div className="absolute inset-0 px-3 pb-3 flex flex-col gap-1 pt-2">
          {Array.from({ length: 14 }, (_, i) => (
            <Skeleton
              key={i}
              variant="text"
              width={`${45 + ((i * 37) % 50)}%`}
              className="!bg-[var(--mui-palette-action-hover)] !text-xs"
            />
          ))}
        </div>
      )}
      {frozen && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-sm">
          <Typography variant="body2" className="text-[var(--mui-palette-text-disabled)]">
            Container stopped
          </Typography>
        </div>
      )}
      {error && !frozen && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-sm">
          <Typography variant="body2" color="error">
            {error.message}
          </Typography>
        </div>
      )}
      {sessionEnded && !frozen && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 rounded-sm gap-3">
          <Typography variant="body2" className="text-[var(--mui-palette-text-disabled)]">
            Session ended
          </Typography>
          <Button size="small" variant="outlined" onClick={reconnect}>
            Reconnect
          </Button>
        </div>
      )}
    </Paper>
  );
});
